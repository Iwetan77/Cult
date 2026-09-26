import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { env } from '../config/env.js';
import { wsSignInFrame, type ApiKeyCredentials } from './auth.js';
import { OrderStatus, PositionStatus, type Account, type Fill, type Order, type OrderSpec, type Position } from './types.js';

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
const DEFINITIVE_OK = new Set([
  OrderStatus.Open,
  OrderStatus.PartiallyFilled,
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Untriggered,
  OrderStatus.Triggered,
  OrderStatus.Executed,
]);
// A failure can be followed by the real outcome for the same rq; give it a beat
// before believing the failure (api-docs: "first non-failure is definitive").
const FAILURE_GRACE_MS = 2500;

export type OrderInput = Omit<OrderSpec, 'rq' | 'lb'> & { lb?: number };

interface Pending {
  resolve: (o: Order) => void;
  reject: (e: Error) => void;
  failure?: Order;
  failureTimer?: NodeJS.Timeout;
  timeout: NodeJS.Timeout;
}

export interface TradingSessionEvents {
  ready: [];
  position: [Position];
  positionClosed: [Position];
  order: [Order];
  fill: [Fill];
  account: [Account];
  disconnected: [number, string];
}

// One authenticated /ws/v1/trading connection for one member wallet. Perpl
// closes the socket (1011) if you send an order for an account the key's wallet
// doesn't own, so the mirror engine holds one of these per member.
export class TradingSession extends EventEmitter<TradingSessionEvents> {
  private ws?: WebSocket;
  private retry = 0;
  private closedByUs = false;
  private pingTimer?: NodeJS.Timeout;
  private lastSn?: number;
  private sn = 0;
  private rqCounter = 0;
  private readyPromise?: Promise<void>;
  private readyResolve?: () => void;
  private pending = new Map<number, Pending>(); // by rq
  private statusWaiters = new Map<number, { rq: number }>(); // by outbound sn

  head = 0;
  accounts = new Map<number, Account>();
  positions = new Map<string, Position>(); // `${acc}:${mkt}`
  openOrders = new Map<number, Order>(); // by oid

  constructor(
    private readonly creds: ApiKeyCredentials,
    readonly label = 'session',
  ) {
    super();
  }

  start(): Promise<void> {
    this.closedByUs = false;
    this.readyPromise ??= new Promise((r) => (this.readyResolve = r));
    this.connect();
    return this.readyPromise;
  }

  stop() {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    this.ws?.close(1000);
    for (const [rq, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error(`session stopped with rq ${rq} in flight`));
    }
    this.pending.clear();
  }

  get primaryAccount(): Account | undefined {
    return [...this.accounts.values()][0];
  }

  private connect() {
    const ws = new WebSocket(`${env.perplWsUrl}/ws/v1/trading`);
    this.ws = ws;
    ws.on('open', async () => {
      // Must be the first frame, and within the idle window (10s testnet).
      ws.send(JSON.stringify(await wsSignInFrame(this.creds)));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ mt: 1, t: Date.now() }));
      }, 30_000);
    });
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onMessage(msg);
    });
    ws.on('close', (code, reason) => {
      clearInterval(this.pingTimer);
      this.lastSn = undefined;
      const why = reason.toString();
      this.emit('disconnected', code, why);
      // Anything in flight is lost silently on close; fail it so callers reconcile.
      for (const [rq, p] of this.pending) {
        clearTimeout(p.timeout);
        clearTimeout(p.failureTimer);
        p.reject(new Error(`socket closed (${code} ${why}) with rq ${rq} in flight`));
      }
      this.pending.clear();
      this.statusWaiters.clear();
      if (this.closedByUs) return;
      const delay = code === 1001 ? 0 : RETRY_DELAYS[Math.min(this.retry++, RETRY_DELAYS.length - 1)];
      setTimeout(() => this.connect(), delay);
    });
    ws.on('error', () => {
      /* close follows */
    });
  }

  private onMessage(msg: any) {
    switch (msg.mt) {
      case 19: {
        // WalletSnapshot: accounts + the sn heartbeats continue from.
        this.lastSn = msg.sn;
        for (const a of (msg.as ?? []) as Account[]) this.upsertAccount(a);
        break;
      }
      case 21:
        this.upsertAccount(msg as Account);
        break;
      case 23:
        this.openOrders.clear();
        for (const o of (msg.d ?? []) as Order[]) this.openOrders.set(o.oid, o);
        break;
      case 24:
        for (const o of (msg.d ?? []) as Order[]) this.onOrder(o);
        break;
      case 25:
        for (const f of (msg.d ?? []) as Fill[]) this.emit('fill', f);
        break;
      case 26: {
        this.positions.clear();
        for (const p of (msg.d ?? []) as Position[]) this.positions.set(`${p.acc}:${p.mkt}`, p);
        // Positions snapshot is the last of the three initial snapshots.
        this.retry = 0;
        this.readyResolve?.();
        this.emit('ready');
        break;
      }
      case 27:
        for (const p of (msg.d ?? []) as Position[]) this.onPosition(p);
        break;
      case 100: {
        if (this.lastSn != null && msg.sn !== this.lastSn + 1) {
          // Gap: state may be stale. Reconnect for fresh snapshots.
          this.ws?.close(4000, 'heartbeat gap');
          return;
        }
        this.lastSn = msg.sn;
        this.head = msg.h;
        break;
      }
      case 3:
        this.onStatus(msg);
        break;
    }
  }

  private upsertAccount(a: Account) {
    this.accounts.set(a.id, a);
    if (a.lfr > this.rqCounter) this.rqCounter = a.lfr;
    this.emit('account', a);
  }

  private onPosition(p: Position) {
    const key = `${p.acc}:${p.mkt}`;
    if (p.st === PositionStatus.Open) {
      this.positions.set(key, p);
      this.emit('position', p);
    } else {
      this.positions.delete(key);
      this.emit('positionClosed', p);
    }
  }

  private onOrder(o: Order) {
    if (o.r) this.openOrders.delete(o.oid);
    else if (o.oid) this.openOrders.set(o.oid, o);
    this.emit('order', o);

    const p = this.pending.get(o.rq);
    if (!p) return;
    if (DEFINITIVE_OK.has(o.st)) {
      clearTimeout(p.timeout);
      clearTimeout(p.failureTimer);
      this.pending.delete(o.rq);
      p.resolve(o);
    } else if (o.st === OrderStatus.Failed && !p.failure) {
      p.failure = o;
      p.failureTimer = setTimeout(() => {
        clearTimeout(p.timeout);
        this.pending.delete(o.rq);
        p.resolve(o);
      }, FAILURE_GRACE_MS);
    }
  }

  private onStatus(msg: { cid?: number; status: { code: number; error: string } }) {
    if (msg.cid == null) return;
    const w = this.statusWaiters.get(msg.cid);
    if (!w) return;
    this.statusWaiters.delete(msg.cid);
    if (msg.status.code === 0) return; // accepted for forwarding; outcome comes on mt:24
    const p = this.pending.get(w.rq);
    if (!p) return;
    clearTimeout(p.timeout);
    this.pending.delete(w.rq);
    p.reject(new Error(`perpl rejected rq ${w.rq}: ${msg.status.code} ${msg.status.error}`));
  }

  // Places one order and resolves with its definitive Order update (which may be
  // st=Failed; callers check). lb defaults to 0 = market's max TTL window.
  // `onRq` runs synchronously before the frame is sent, so a caller can record the
  // request id before any position/order event for it can possibly arrive.
  async placeOrder(input: OrderInput, opts: { timeoutMs?: number; onRq?: (rq: number) => void } = {}): Promise<Order> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    await this.readyPromise;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(`${this.label}: socket not open`);
    const acct = this.accounts.get(input.acc);
    const floor = acct ? acct.lfr : 0;
    const rq = Math.max(this.rqCounter, floor, Date.now()) + 1;
    this.rqCounter = rq;
    opts.onRq?.(rq);
    const sn = ++this.sn;
    const frame = { mt: 22, sn, ...input, rq, lb: input.lb ?? 0 };

    return new Promise<Order>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(rq);
        reject(new Error(`${this.label}: no outcome for rq ${rq} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(rq, { resolve, reject, timeout });
      this.statusWaiters.set(sn, { rq });
      this.ws!.send(JSON.stringify(frame));
    });
  }
}
