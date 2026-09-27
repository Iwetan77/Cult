import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { hasSignerOverride } from '../accounts/signers.js';
import { rpc } from '../chain/signer.js';
import { NadWatcher, type NadTradeEvent } from '../nadfun/watcher.js';
import { getExchangeInfo } from '../perpl/context.js';
import type { TradingSession } from '../perpl/session.js';
import { PositionSide, type Position } from '../perpl/types.js';
import { monPriceAusd } from '../prices.js';
import { clans } from '../store/clans.js';
import { members } from '../store/members.js';
import { venue as defaultVenue, type TradeSide, type Venue, type VenueAdapter } from '../venues/index.js';
import { isEngineOrder, isEngineTx, recordRef } from './origin.js';
import { mirrors, trades, type LeaderTrade, type Mirror } from './repo.js';
import { leaderDollarFraction, mirrorNotional } from './sizing.js';
import { erc20Abi } from '../chain/exchange.js';
import { GAS_RESERVE_WEI } from '../venues/nadfun.js';

// Perpl position status reasons that mean "a new position now exists".
const SR_OPENED = 21;
const SR_INVERTED = 18;

export interface MirrorEngineConfig {
  optOutSeconds: number;
  minMirrorAusd?: number; // don't fire dust mirrors
}

export interface MirrorEngineDeps {
  sessionFor: (userId: string) => Promise<TradingSession>;
  venue?: (v: Venue) => VenueAdapter;
  nadWatcher?: NadWatcher | null; // null disables Nad.fun leader detection
}

export interface MirrorEngineEvents {
  trade: [LeaderTrade];
  tradeClosed: [LeaderTrade];
  mirror: [Mirror];
}

// A member's own trade on either venue, however it was detected.
export interface LeaderOpen {
  venue: Venue;
  userId: string;
  market: string;
  side: TradeSide;
  sizeRaw: string;
  entryPriceAusd: number | null;
  leverageHundredths: number;
  marginFraction: number;
  accountId?: number;
  positionId?: number;
  openTx?: string | null;
}

// One engine, two venues. A clan member opens a trade themselves (Perpl
// position or Nad.fun buy) -> every other member of their clan(s) gets a
// pending mirror with a skip deadline -> at the deadline, un-skipped mirrors
// are sized from each follower's own balance and policy and opened through the
// venue adapter -> when the leader exits, the mirrors exit.
//
// Leader detection: Perpl via each member's trading websocket; Nad.fun via the
// router log watcher. Anything this engine (or a manual stack) sends is tagged
// before it leaves (engine_orders / engine_txs), so a mirror is never picked
// up as a new leader trade. Manual stacking is not here: see mirror/stack.ts.
export class MirrorEngine extends EventEmitter<MirrorEngineEvents> {
  private watchingPerpl = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly venue: (v: Venue) => VenueAdapter;
  private readonly nad: NadWatcher | null;

  constructor(
    readonly cfg: MirrorEngineConfig,
    private readonly deps: MirrorEngineDeps,
  ) {
    super();
    this.venue = deps.venue ?? defaultVenue;
    this.nad = deps.nadWatcher === undefined ? new NadWatcher() : deps.nadWatcher;
    this.nad?.on('trade', (t) => void this.onNadTrade(t).catch((e) => this.log('nadfun', e)));
  }

  async start() {
    for (const userId of clans.allMemberUserIds()) await this.watch(userId).catch((e) => this.log(`watch ${userId}`, e));
    await this.nad?.start();
    await this.recover();
  }

  stop() {
    this.nad?.stop();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  async watch(userId: string) {
    const m = members.get(userId);
    if (!m) return;
    this.nad?.add(m.wallet);
    if (this.watchingPerpl.has(userId) || !members.credentials(userId)) return;
    const session = await this.deps.sessionFor(userId);
    this.watchingPerpl.add(userId);
    session.on('position', (p) => void this.onPerplPosition(userId, session, p).catch((e) => this.log('perpl position', e)));
    session.on('positionClosed', (p) => void this.onPerplClosed(userId, p).catch((e) => this.log('perpl close', e)));
  }

  // ---- leader detection: Perpl ---------------------------------------------

  private async onPerplPosition(userId: string, session: TradingSession, p: Position) {
    if (p.sr !== SR_OPENED && p.sr !== SR_INVERTED) return; // increases/decreases aren't new trades
    if (isEngineOrder(p.acc, p.rq)) return; // our own mirror/stack
    if (trades.byPosition(p.acc, p.pid)) return; // replay after reconnect
    if (p.sr === SR_INVERTED) {
      const prev = trades.openFor(userId, 'perpl', String(p.mkt));
      if (prev) await this.closeTrade(prev);
    }
    const acct = session.accounts.get(p.acc);
    const { collateralDecimals } = await getExchangeInfo();
    const unit = 10 ** collateralDecimals;
    const collateral = Number(p.c) / unit;
    const free = acct ? (Number(acct.b) - Number(acct.lb)) / unit : 0;
    const { getMarket, scale } = await import('../perpl/context.js');
    const m = await getMarket(p.mkt);
    await this.leaderOpened({
      venue: 'perpl',
      userId,
      market: String(p.mkt),
      side: p.sd === PositionSide.Long ? 'long' : 'short',
      sizeRaw: String(p.s),
      entryPriceAusd: scale.unprice(p.ep, m),
      leverageHundredths: p.lv,
      marginFraction: collateral > 0 ? collateral / (free + collateral) : 0,
      accountId: p.acc,
      positionId: p.pid,
      openTx: p.ots?.txid ?? p.at?.txid ?? null,
    });
  }

  private async onPerplClosed(userId: string, p: Position) {
    const trade = trades.byPosition(p.acc, p.pid) ?? trades.openFor(userId, 'perpl', String(p.mkt));
    if (trade && !trade.closedAt) await this.closeTrade(trade);
  }

  // ---- leader detection: Nad.fun --------------------------------------------

  private async onNadTrade(t: NadTradeEvent) {
    if (isEngineTx(t.txHash)) return; // our own mirror/stack
    const member = members.byWallet(t.wallet);
    if (!member) return;
    const open = trades.openFor(member.userId, 'nadfun', t.token);

    if (t.side === 'buy') {
      if (open) return; // adding to a holding they already lead with isn't a new trade
      const monPx = await monPriceAusd();
      const spentUsd = Number(ethers.formatEther(t.monAmount)) * monPx;
      // Share of their spendable dollars this buy used, just before it.
      const tag = t.blockNumber - 1;
      const { collateralToken, collateralDecimals } = await getExchangeInfo();
      const [monBeforeWei, ausdBeforeRaw] = await Promise.all([
        rpc().getBalance(t.wallet, tag).catch(() => 0n),
        new ethers.Contract(collateralToken, erc20Abi, rpc()).getFunction('balanceOf')(t.wallet, { blockTag: tag }).catch(() => 0n) as Promise<bigint>,
      ]);
      const fraction = leaderDollarFraction({
        spentUsd,
        ausdBeforeUsd: Number(ethers.formatUnits(ausdBeforeRaw, collateralDecimals)),
        monBeforeWei,
        reserveWei: GAS_RESERVE_WEI,
        monPx,
      });
      const tokens = Number(ethers.formatEther(t.tokenAmount));
      await this.leaderOpened({
        venue: 'nadfun',
        userId: member.userId,
        market: t.token,
        side: 'buy',
        sizeRaw: t.tokenAmount.toString(),
        entryPriceAusd: tokens > 0 ? spentUsd / tokens : null,
        leverageHundredths: 100,
        marginFraction: fraction,
        openTx: t.txHash,
      });
      return;
    }

    // Sell: only a full exit closes the trade (partial sells don't propagate).
    if (!open) return;
    const { tokenBalance } = await import('../nadfun/trading.js');
    const left = await tokenBalance(t.token, t.wallet);
    if (left * 100n <= BigInt(open.size)) await this.closeTrade(open); // <1% of the original left = exited
  }

  // ---- shared pipeline ---------------------------------------------------------

  async leaderOpened(e: LeaderOpen): Promise<LeaderTrade | null> {
    const clanIds = clans.forUser(e.userId).map((c) => c.id);
    if (clanIds.length === 0) return null;
    const trade = trades.insert({
      id: randomUUID(),
      venue: e.venue,
      userId: e.userId,
      accountId: e.accountId ?? null,
      market: e.market,
      side: e.side,
      positionId: e.positionId ?? null,
      size: e.sizeRaw,
      entryPrice: e.entryPriceAusd,
      leverage: e.leverageHundredths,
      marginFraction: e.marginFraction,
      openTx: e.openTx ?? null,
      openedAt: Date.now(),
    });
    this.emit('trade', trade);

    const skipUntil = Date.now() + this.cfg.optOutSeconds * 1000;
    const seen = new Set<string>([e.userId]);
    for (const clanId of clanIds) {
      for (const m of clans.members(clanId)) {
        if (seen.has(m.userId)) continue; // one mirror per follower even across shared clans
        seen.add(m.userId);
        if (!m.policy.enabled || !this.canTrade(m.userId, e.venue)) continue;
        const mirror = mirrors.insertPending({ tradeId: trade.id, clanId, userId: m.userId, skipUntil });
        this.emit('mirror', mirror);
        this.schedule(mirror);
      }
    }
    return trade;
  }

  // Perpl needs an enrolled key and account; Nad.fun needs a wallet signer the
  // backend may use (the Privy grant, or a registered test key). An injected
  // venue (tests) decides for itself.
  private canTrade(userId: string, v: Venue) {
    const m = members.get(userId);
    if (!m) return false;
    if (this.deps.venue) return true;
    if (v === 'perpl') return !!members.credentials(userId) && !!m.perplAccountId;
    return !!m.privyWalletId || hasSignerOverride(userId);
  }

  async closeTrade(trade: LeaderTrade) {
    trades.markClosed(trade.id);
    this.emit('tradeClosed', { ...trade, closedAt: Date.now() });
    const toClose: Mirror[] = [];
    for (const m of mirrors.forTrade(trade.id)) {
      if (m.status === 'pending') {
        this.unschedule(m.id);
        this.emit('mirror', mirrors.transition(m.id, 'pending', 'cancelled', { error: 'leader closed before mirror fired' })!);
      } else if (m.status === 'open') {
        toClose.push(m);
      }
    }
    // Each follower is their own wallet/account, so unwind them in parallel:
    // the last follower shouldn't exit later just because of the clan's size.
    await Promise.all(toClose.map((m) => this.closeMirror(m, trade)));
  }

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
      const adapter = this.venue(trade.venue);
      const membership = clans.membership(m.clanId, m.userId)!;
      const sizing = mirrorNotional(
        {
          leaderMarginFraction: trade.marginFraction,
          leaderLeverage: trade.leverage / 100,
          marketMaxLeverage: await adapter.maxLeverage(trade.market),
          followerFreeBalanceUsd: await adapter.freeBalanceAusd(m.userId),
          policy: membership.policy,
        },
        this.cfg.minMirrorAusd ?? 1,
      );
      if (!sizing.ok) throw new Error(`not sized: ${sizing.reason}`);

      const fill = await adapter.open({
        userId: m.userId,
        market: trade.market,
        side: trade.side,
        notionalAusd: sizing.notionalUsd,
        leverage: sizing.leverage,
        onRef: (ref) => {
          recordRef(ref, 'mirror_open', m.id);
          if (ref.rq != null) mirrors.patch(m.id, { openRq: ref.rq });
        },
      });
      const updated = mirrors.transition(m.id, 'submitting', 'open', {
        marginUsd: sizing.marginUsd,
        notionalUsd: fill.notionalAusd,
        size: fill.sizeRaw,
        capApplied: sizing.capsApplied.join(','),
        openOid: fill.orderId ?? null,
        openTx: fill.txHash ?? null,
      })!;
      this.emit('mirror', updated);
      if (trades.get(trade.id)!.closedAt) await this.closeMirror(updated, trade); // leader left while we filled
    } catch (e) {
      this.emit('mirror', mirrors.transition(m.id, 'submitting', 'failed', { error: String(e).slice(0, 500) })!);
    }
  }

  private async closeMirror(m: Mirror, trade: LeaderTrade) {
    const adapter = this.venue(trade.venue);
    // If the member already got out on their own, there's nothing to unwind.
    const held = await adapter.holdings(m.userId, [trade.market]).catch(() => null);
    if (held && held.length === 0) {
      this.emit('mirror', mirrors.transition(m.id, 'open', 'closed', { error: 'member had already exited this position' })!);
      return;
    }
    try {
      const fill = await adapter.close({
        userId: m.userId,
        market: trade.market,
        sizeRaw: m.size ?? undefined,
        onRef: (ref) => {
          recordRef(ref, 'mirror_close', m.id);
          if (ref.rq != null) mirrors.patch(m.id, { closeRq: ref.rq });
        },
      });
      this.emit('mirror', mirrors.transition(m.id, 'open', 'closed', { closeOid: fill.orderId ?? null, closeTx: fill.txHash ?? null })!);
    } catch (e) {
      mirrors.patch(m.id, { error: `close failed: ${String(e).slice(0, 400)}` });
      this.emit('mirror', mirrors.get(m.id)!);
    }
  }

  // After a restart: re-arm pending mirrors; flag interrupted submits.
  private async recover() {
    for (const m of mirrors.byStatus('pending')) this.schedule(m);
    for (const m of mirrors.byStatus('submitting')) {
      mirrors.patch(m.id, { error: 'interrupted mid-submit; reconcile against the venue before retrying' });
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
