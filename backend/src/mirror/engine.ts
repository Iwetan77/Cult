import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getExchangeInfo, getMarket, getTicker, maxLeverageHundredths, scale } from '../perpl/context.js';
import type { TradingSession } from '../perpl/session.js';
import { PositionSide, type Position } from '../perpl/types.js';
import { clans } from '../store/clans.js';
import { members } from '../store/members.js';
import { closePosition, openPosition } from '../trading/positions.js';
import { recordEngineOrder, isEngineOrder } from './origin.js';
import { mirrors, trades, type LeaderTrade, type Mirror } from './repo.js';
import { sizeMirror } from './sizing.js';

// Position status reasons that mean "a new position now exists".
const SR_OPENED = 21;
const SR_INVERTED = 18;

export interface MirrorEngineConfig {
  optOutSeconds: number;
}

export interface MirrorEngineEvents {
  trade: [LeaderTrade];
  tradeClosed: [LeaderTrade];
  mirror: [Mirror];
}

// Auto-mirror: a clan member opens a position themselves -> every other member
// of their clan(s) gets a pending mirror with a skip deadline -> at the
// deadline, un-skipped mirrors are sized from each follower's own balance and
// policy and opened -> when the leader's position closes, the mirrors close.
//
// Manual stacking is NOT here; see mirror/stack.ts. Positions this engine (or
// the stack path) opens are tagged in engine_orders and never treated as a new
// leader trade, which is what stops mirrors from mirroring each other.
export class MirrorEngine extends EventEmitter<MirrorEngineEvents> {
  private watching = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly cfg: MirrorEngineConfig,
    private readonly sessionFor: (userId: string) => Promise<TradingSession>,
  ) {
    super();
  }

  async start() {
    for (const userId of clans.allMemberUserIds()) {
      if (members.credentials(userId)) await this.watch(userId);
    }
    await this.recover();
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  async watch(userId: string) {
    if (this.watching.has(userId)) return;
    const session = await this.sessionFor(userId);
    this.watching.add(userId);
    session.on('position', (p) => void this.onPosition(userId, session, p).catch((e) => this.log('onPosition', e)));
    session.on('positionClosed', (p) => void this.onPositionClosed(p).catch((e) => this.log('onPositionClosed', e)));
  }

  // ---- leader side -------------------------------------------------------

  private async onPosition(userId: string, session: TradingSession, p: Position) {
    if (p.sr !== SR_OPENED && p.sr !== SR_INVERTED) return; // increases/decreases aren't new trades
    if (isEngineOrder(p.acc, p.rq)) return; // our own mirror/stack, not a leader trade
    if (trades.byPosition(p.acc, p.pid)) return; // already seen (reconnect replay)
    if (p.sr === SR_INVERTED) {
      // Flip = old side closed + new side opened. Close out the old trade first.
      const prev = trades.openFor(p.acc, p.mkt);
      if (prev) await this.closeTrade(prev);
    }

    const clanIds = clans.forUser(userId).map((c) => c.id);
    if (clanIds.length === 0) return;

    const acct = session.accounts.get(p.acc);
    const { collateralDecimals } = await getExchangeInfo();
    const unit = 10 ** collateralDecimals;
    const collateral = Number(p.c) / unit;
    const free = acct ? (Number(acct.b) - Number(acct.lb)) / unit : 0;
    const marginFraction = collateral > 0 ? collateral / (free + collateral) : 0;

    const trade = trades.insert({
      id: randomUUID(),
      userId,
      accountId: p.acc,
      marketId: p.mkt,
      side: p.sd === PositionSide.Long ? 'long' : 'short',
      positionId: p.pid,
      size: p.s,
      entryPrice: p.ep,
      leverage: p.lv,
      marginFraction,
      openTx: p.ots?.txid ?? p.at?.txid ?? null,
      openedAt: Date.now(),
    });
    this.emit('trade', trade);

    const skipUntil = Date.now() + this.cfg.optOutSeconds * 1000;
    const seen = new Set<string>([userId]);
    for (const clanId of clanIds) {
      for (const m of clans.members(clanId)) {
        if (seen.has(m.userId)) continue; // one mirror per follower even across shared clans
        seen.add(m.userId);
        if (!m.policy.enabled || !members.credentials(m.userId)) continue;
        const mirror = mirrors.insertPending({ tradeId: trade.id, clanId, userId: m.userId, skipUntil });
        this.emit('mirror', mirror);
        this.schedule(mirror);
      }
    }
  }

  private async onPositionClosed(p: Position) {
    const trade = trades.byPosition(p.acc, p.pid) ?? trades.openFor(p.acc, p.mkt);
    if (trade && !trade.closedAt) await this.closeTrade(trade);
  }

  private async closeTrade(trade: LeaderTrade) {
    trades.markClosed(trade.id);
    this.emit('tradeClosed', { ...trade, closedAt: Date.now() });
    for (const m of mirrors.forTrade(trade.id)) {
      if (m.status === 'pending') {
        this.unschedule(m.id);
        this.emit('mirror', mirrors.transition(m.id, 'pending', 'cancelled', { error: 'leader closed before mirror fired' })!);
      } else if (m.status === 'open') {
        await this.closeMirror(m, trade);
      }
    }
  }

  // ---- follower side -----------------------------------------------------

  skip(mirrorId: string, userId: string): Mirror {
    const m = mirrors.get(mirrorId);
    if (!m || m.userId !== userId) throw new MirrorError(404, 'mirror not found');
    if (m.status !== 'pending') throw new MirrorError(409, `mirror is ${m.status}, not pending`);
    if (Date.now() >= m.skipUntil) throw new MirrorError(409, 'skip window has passed');
    const updated = mirrors.transition(mirrorId, 'pending', 'skipped');
    if (!updated) throw new MirrorError(409, 'mirror already moved on');
    this.unschedule(mirrorId);
    this.emit('mirror', updated);
    return updated;
  }

  private schedule(m: Mirror) {
    const delay = Math.max(0, m.skipUntil - Date.now());
    this.timers.set(
      m.id,
      setTimeout(() => {
        this.timers.delete(m.id);
        void this.fire(m.id).catch((e) => this.log('fire', e));
      }, delay),
    );
  }

  private unschedule(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  async fire(mirrorId: string) {
    // pending -> submitting is the lock: skip() and a second fire() both lose here.
    const m = mirrors.transition(mirrorId, 'pending', 'submitting');
    if (!m) return;
    const trade = trades.get(m.tradeId)!;
    if (trade.closedAt) {
      this.emit('mirror', mirrors.transition(m.id, 'submitting', 'cancelled', { error: 'leader already closed' })!);
      return;
    }
    try {
      const session = await this.sessionFor(m.userId);
      const follower = members.get(m.userId)!;
      const acct = session.accounts.get(follower.perplAccountId!);
      if (!acct) throw new Error('follower has no Perpl account on session');
      const membership = clans.membership(m.clanId, m.userId)!;
      const market = await getMarket(trade.marketId);
      const { d } = await getTicker();
      const { collateralDecimals } = await getExchangeInfo();

      const sizing = sizeMirror({
        leaderMarginFraction: trade.marginFraction,
        leaderLeverage: trade.leverage / 100,
        marketMaxLeverage: maxLeverageHundredths(market) / 100,
        followerFreeBalanceUsd: (Number(acct.b) - Number(acct.lb)) / 10 ** collateralDecimals,
        markPrice: scale.unprice(d[String(market.id)]?.mrk ?? 0, market),
        sizeDecimals: market.config.size_decimals,
        policy: membership.policy,
      });
      if (!sizing.ok) throw new Error(`not sized: ${sizing.reason}`);

      const order = await openPosition(session, {
        accountId: acct.id,
        marketId: market.id,
        side: trade.side,
        size: sizing.size,
        leverage: sizing.leverage,
        onRq: (rq) => {
          recordEngineOrder(acct.id, rq, 'mirror_open', m.id);
          mirrors.patch(m.id, { openRq: rq });
        },
      });
      const updated = mirrors.transition(m.id, 'submitting', 'open', {
        marginUsd: sizing.marginUsd,
        notionalUsd: sizing.notionalUsd,
        size: order.fs,
        capApplied: sizing.capsApplied.join(','),
        openOid: order.oid,
        openTx: order.at?.txid ?? null,
      })!;
      this.emit('mirror', updated);
      // Leader may have closed while we were filling.
      if (trades.get(trade.id)!.closedAt) await this.closeMirror(updated, trade);
    } catch (e) {
      this.emit('mirror', mirrors.transition(m.id, 'submitting', 'failed', { error: String(e).slice(0, 500) })!);
    }
  }

  private async closeMirror(m: Mirror, trade: LeaderTrade) {
    try {
      const session = await this.sessionFor(m.userId);
      const follower = members.get(m.userId)!;
      const order = await closePosition(session, follower.perplAccountId!, trade.marketId, {
        sizeScaled: m.size ?? undefined,
        onRq: (rq) => {
          recordEngineOrder(follower.perplAccountId!, rq, 'mirror_close', m.id);
          mirrors.patch(m.id, { closeRq: rq });
        },
      });
      this.emit('mirror', mirrors.transition(m.id, 'open', 'closed', { closeOid: order.oid, closeTx: order.at?.txid ?? null })!);
    } catch (e) {
      mirrors.patch(m.id, { error: `close failed: ${String(e).slice(0, 400)}` });
      this.emit('mirror', mirrors.get(m.id)!);
    }
  }

  // After a restart: fire anything whose window lapsed, re-arm the rest.
  private async recover() {
    for (const m of mirrors.byStatus('pending')) this.schedule(m);
    for (const m of mirrors.byStatus('submitting')) {
      // Unknown outcome; leave for reconciliation rather than risk a double open.
      mirrors.patch(m.id, { error: 'interrupted mid-submit; reconcile against Perpl before retrying' });
    }
  }

  private log(where: string, e: unknown) {
    console.error(`[mirror] ${where}:`, e);
  }
}

export class MirrorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

