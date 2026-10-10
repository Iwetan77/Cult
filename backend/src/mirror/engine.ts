import { numEnv } from '../config/env.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { hasSignerOverride } from '../accounts/signers.js';
import { backendSignerStatus } from '../privy/policy.js';
import { rpc } from '../chain/signer.js';
import { NadWatcher, type NadTradeEvent } from '../nadfun/watcher.js';
import { getExchangeInfo } from '../perpl/context.js';
import type { TradingSession } from '../perpl/session.js';
import { OrderStatus, PositionSide, PositionStatus, type Order, type Position } from '../perpl/types.js';
import { monPriceAusd } from '../prices.js';
import { clans } from '../store/clans.js';
import { members } from '../store/members.js';
import { venue as defaultVenue, venueOf, type TradeSide, type Venue, type VenueAdapter } from '../venues/index.js';
import { isEngineOrder, isEngineTx, recordRef } from './origin.js';
import { adjustments, mirrors, sizeFactor, tradeCults, trades, type Adjustment, type LeaderTrade, type Mirror } from './repo.js';
import { takeAudience } from './audience.js';
import { leaderDollarFraction, mirrorNotional } from './sizing.js';
import { landed as defaultLanded, type Landed, type LandedLookup } from './reconcile.js';
import { erc20Abi } from '../chain/exchange.js';
import { GAS_RESERVE_WEI } from '../venues/nadfun.js';
import { getDb } from '../store/db.js';
import { memberOrders } from './member-orders.js';
import { allocatedHoldings, allocationsFor } from './allocations.js';
import type { CloseInput, Fill, OpenInput } from '../venues/types.js';

// Perpl position status reasons that mean "a new position now exists".
const SR_OPENED = 21;
const SR_INVERTED = 18;
// ...and the ones where the member changed the size of the one they have.
const SR_INCREASED = 17;
const SR_DECREASED = 14;

export interface MirrorEngineConfig {
  optOutSeconds: number;
  // A leader trade seen later than this (e.g. catching up after downtime)
  // is tracked but not mirrored: copying it now would be a different trade.
  maxLeaderAgeSeconds?: number;
  minMirrorAusd?: number; // don't fire dust mirrors
}

export interface MirrorEngineDeps {
  sessionFor: (userId: string) => Promise<TradingSession>;
  venue?: (v: Venue) => VenueAdapter;
  nadWatcher?: NadWatcher | null; // null disables Nad.fun leader detection
  landed?: LandedLookup; // what a tagged order/tx did on the venue (crash recovery)
}

export interface MirrorEngineEvents {
  trade: [LeaderTrade];
  tradeChanged: [LeaderTrade, number]; // the leader added or partly exited; size after / before
  tradeClosed: [LeaderTrade];
  liquidation: [string, Position];
  mirror: [Mirror];
  adjustment: [Adjustment];
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
  detectedLateBySeconds?: number; // set when the trade happened well before we saw it
  id?: string;
  cultIds?: string[];
  keepPrivate?: boolean;
  netPositionId?: number;
  booking?: { orderId: string; size: string; notional: number };
}

// One engine, two venues. A clan member opens a trade themselves (Perpl
// position or Nad.fun buy) -> every other member of their clan(s) gets a
// pending mirror with a skip deadline -> at the deadline, un-skipped mirrors
// are sized from each follower's own balance and policy and opened through the
// venue adapter -> when the leader adds or partly exits, each open mirror
// follows by the same ratio of its own size (adds get the skip window, partial
// exits go straight out) -> when the leader exits, the mirrors exit.
//
// Leader detection: Perpl via each member's trading websocket; Nad.fun via the
// router log watcher. Anything this engine (or a manual stack) sends is tagged
// before it leaves (engine_orders / engine_txs), so a mirror is never picked
// up as a new leader trade. Manual stacking is not here: see mirror/stack.ts.
export class MirrorEngine extends EventEmitter<MirrorEngineEvents> {
  private watchingPerpl = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private attempts = new Map<string, number>(); // mirror/adjustment id -> fire attempts so far
  private lanes = new Map<string, Promise<unknown>>(); // mirror id -> its adjustments and close, one at a time
  private perplSeen = new Map<string, bigint>(); // "acc:pid" -> last position size seen, ours included
  private perplPositions = new Map<string, Position>(); // member+market, including private and copied size
  private recovering: Promise<void> = Promise.resolve();
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
    const watched = new Set([...clans.allMemberUserIds(), ...members.all().filter(member => member.apiKey).map(member => member.userId)]);
    for (const userId of watched) await this.watch(userId).catch((e) => this.log(`watch ${userId}`, e));
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
    if (this.watchingPerpl.has(userId)) return;
    this.watchingPerpl.add(userId);
    const seed = () => {
      for (const p of session.positions?.values() ?? []) {
        this.perplSeen.set(p.acc + ':' + p.pid, BigInt(p.s));
        this.perplPositions.set(userId + ':' + p.mkt, p);
        trades.attachPosition(userId, String(p.mkt), p.pid);
      }
    };
    seed();
    const recoverOrders = () => {
      if (!this.deps.venue) void this.recoverOwnOrders(userId).catch(e => this.log('member order recovery', e));
    };
    recoverOrders();
    session.on('ready', () => { seed(); recoverOrders(); });
    session.on('order', o => void this.onOwnPerplOrder(o).catch(e => this.log('member order', e)));
    session.on('position', (p) => void this.onPerplPosition(userId, session, p).catch((e) => this.log('perpl position', e)));
    session.on('positionClosed', (p) => void this.onPerplClosed(userId, p).catch((e) => this.log('perpl close', e)));
  }

  // ---- leader detection: Perpl ---------------------------------------------

  private async onPerplPosition(userId: string, session: TradingSession, p: Position) {
    const previous = this.perplPositions.get(userId + ':' + p.mkt);
    this.perplPositions.set(userId + ':' + p.mkt, p);
    trades.attachPosition(userId, String(p.mkt), p.pid);
    if (memberOrders.perpl(p.acc, p.rq)) {
      this.perplSeen.set(p.acc + ':' + p.pid, BigInt(p.s));
      return;
    }
    if (p.sr === SR_INCREASED || p.sr === SR_DECREASED) return this.onPerplResized(userId, p, previous);
    if (p.sr !== SR_OPENED && p.sr !== SR_INVERTED) return;
    this.perplSeen.set(`${p.acc}:${p.pid}`, BigInt(p.s));
    if (isEngineOrder(p.acc, p.rq)) return; // our own mirror/stack
    if (trades.byPosition(p.acc, p.pid)) return; // replay after reconnect
    if (p.sr === SR_INVERTED) {
      await this.reduceExternal(userId, 'perpl', String(p.mkt), p.sd === PositionSide.Long ? 'short' : 'long', 0n, 1n);
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

  // The leader grew or shrank a position they lead. Only their own orders
  // count: a mirror or stack of someone else's trade can land on the same
  // Perpl position, so their share is tracked apart from the position's total.
  private async onPerplResized(userId: string, p: Position, previous?: Position) {
    const key = `${p.acc}:${p.pid}`;
    const all = trades.openOnMarket(userId, 'perpl', String(p.mkt));
    const trade = trades.byPosition(p.acc, p.pid);
    const total = BigInt(p.s);
    const seen = this.perplSeen.get(key) ?? (trade ? BigInt(trade.size) : total);
    this.perplSeen.set(key, total);
    if (total === seen) return;
    if (isEngineOrder(p.acc, p.rq)) return;
    if (total < seen) return this.reduceExternal(userId, 'perpl', String(p.mkt), p.sd === PositionSide.Long ? 'long' : 'short', total, seen);
    if (!trade || trade.closedAt || all.length !== 1) {
      const { getMarket, scale } = await import('../perpl/context.js');
      const m = await getMarket(p.mkt);
      const newEntry = previous ? (scale.unprice(p.ep, m) * Number(total) - scale.unprice(previous.ep, m) * Number(seen)) / Number(total - seen) : null;
      const deltaMargin = (newEntry ?? scale.unprice(p.ep, m)) * scale.unsize(Number(total - seen), m) / (p.lv / 100);
      const free = await this.venue('perpl').freeBalanceAusd(userId);
      return this.leaderOpened({ venue: 'perpl', userId, market: String(p.mkt),
        side: p.sd === PositionSide.Long ? 'long' : 'short', sizeRaw: (total - seen).toString(),
        entryPriceAusd: newEntry != null && newEntry > 0 && Number.isFinite(newEntry) ? newEntry : null,
        leverageHundredths: p.lv, marginFraction: deltaMargin > 0 ? deltaMargin / (free + deltaMargin) : 0,
        accountId: p.acc, netPositionId: p.pid, openTx: p.at?.txid ?? null });
    }
    const own = BigInt(trade.size) + (total - seen);
    if (own <= 0n) return this.closeTrade(trade);
    const { getMarket, scale } = await import('../perpl/context.js');
    await this.leaderResized(trade, own, scale.unprice(p.ep, await getMarket(p.mkt)));
  }

  private async onPerplClosed(userId: string, p: Position) {
    if (p.st === PositionStatus.Liquidated) this.emit('liquidation', userId, p);
    this.perplSeen.delete(`${p.acc}:${p.pid}`);
    this.perplPositions.delete(userId + ':' + p.mkt);
    const own = memberOrders.perpl(p.acc, p.rq);
    if (p.st !== PositionStatus.Liquidated && (own?.kind === 'close' || isEngineOrder(p.acc, p.rq))) return;
    await this.reduceExternal(userId, 'perpl', String(p.mkt), p.sd === PositionSide.Long ? 'long' : 'short', 0n, BigInt(p.s ?? '0') || 1n);
  }

  // ---- leader detection: Nad.fun --------------------------------------------

  private async onNadTrade(t: NadTradeEvent) {
    if (isEngineTx(t.txHash)) return; // our own mirror/stack
    const member = members.byWallet(t.wallet);
    if (!member) return;
    const own = memberOrders.tx(t.txHash);
    if (own) {
      const tokens = Number(ethers.formatEther(t.tokenAmount));
      const value = Number(ethers.formatEther(t.monAmount)) * await monPriceAusd();
      await this.bookOwnFill(own.id, { venue: 'nadfun', market: t.token, side: 'buy', sizeRaw: t.tokenAmount.toString(),
        size: tokens, priceAusd: tokens > 0 ? value / tokens : 0, notionalAusd: value, txHash: t.txHash });
      return;
    }
    const open = trades.openFor(member.userId, 'nadfun', t.token);

    const lateBy = t.blockTime > 0 ? Math.max(0, Math.round((Date.now() - t.blockTime) / 1000)) : undefined;

    const lots = trades.openOnMarket(member.userId, 'nadfun', t.token);
    if (t.side === 'buy' && open && lots.length === 1) {
      // Buying more of a token they already lead: followers add the same share of their own mirror.
      const spentUsd = Number(ethers.formatEther(t.monAmount)) * (await monPriceAusd());
      const before = BigInt(open.size);
      const after = before + t.tokenAmount;
      const [heldBefore, heldAfter] = [Number(ethers.formatEther(before)), Number(ethers.formatEther(after))];
      const entry = open.entryPrice != null && heldAfter > 0 ? (open.entryPrice * heldBefore + spentUsd) / heldAfter : open.entryPrice;
      await this.leaderResized(open, after, entry, lateBy);
      return;
    }

    if (t.side === 'buy') {
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
        detectedLateBySeconds: lateBy,
      });
      return;
    }

    // Sell. What's left of the trade decides: under 1% of it is a full exit,
    // anything more is a partial one the mirrors follow proportionally. Also
    // an exit if the wallet held nothing after that block (e.g. two sells in
    // one block, or tokens moved out before selling the rest).
    if (!open) return;
    if (lots.length > 1) {
      const { tokenBalance } = await import('../nadfun/trading.js');
      const after = await tokenBalance(t.token, t.wallet, t.blockNumber);
      await this.reduceExternal(member.userId, 'nadfun', t.token, 'buy', after, after + t.tokenAmount);
      return;
    }
    const before = BigInt(open.size);
    const after = before > t.tokenAmount ? before - t.tokenAmount : 0n;
    const { tokenBalance } = await import('../nadfun/trading.js');
    const heldAtBlock = await tokenBalance(t.token, t.wallet, t.blockNumber).catch(() => null);
    if (after * 100n <= before || heldAtBlock === 0n) return this.closeTrade(open);
    await this.leaderResized(open, after, open.entryPrice);
  }

  // ---- shared pipeline ---------------------------------------------------------

  async executeOwnOpen(i: OpenInput, cultIds?: string[]): Promise<Fill> {
    return this.inLane('member:' + i.userId + ':' + i.market.toLowerCase(), async () => {
      await this.watch(i.userId);
      const v = venueOf(i.market);
      const adapter = this.venue(v);
      const held = await adapter.holdings(i.userId, [i.market]);
      if (v === 'perpl' && held.some(h => h.market === i.market && h.side !== i.side && BigInt(h.sizeRaw) > 0n)) {
        throw new MirrorError(409, 'Close your existing opposite-side position first. Perpl combines trades on the same asset into one net position.');
      }
      const eligible = clans.adminCultIds(i.userId);
      if (cultIds?.some(id => !eligible.includes(id))) throw new MirrorError(403, 'Only cult owners and admins can post trades to that cult.');
      const free = await adapter.freeBalanceAusd(i.userId);
      const leverage = v === 'perpl' ? i.leverage ?? 1 : 1;
      const order = memberOrders.begin({ userId: i.userId, venue: v, market: i.market, kind: 'open', side: i.side,
        leverage: Math.round(leverage * 100), marginFraction: free > 0 ? Math.min(1, i.notionalAusd / leverage / free) : 0,
        cultIds: cultIds ?? eligible, markerId: null, requestedNotional: i.notionalAusd });
      try {
        const fill = await adapter.open({ ...i, onRef: ref => { memberOrders.ref(order.id, ref); i.onRef?.(ref); } });
        memberOrders.ref(order.id, { rq: fill.requestId, accountId: members.get(i.userId)?.perplAccountId ?? undefined, txHash: fill.txHash ?? undefined });
        await this.bookOwnFill(order.id, fill);
        const tradeId = memberOrders.get(order.id)!.allocationId;
        return { ...fill, tradeId, markerId: 'trade:' + tradeId };
      } catch (e) { memberOrders.failed(order.id); throw e; }
    });
  }

  async executeOwnClose(i: CloseInput, markerId?: string): Promise<Fill> {
    const run = () => this.inLane('member:' + i.userId + ':' + i.market.toLowerCase(), async () => {
      await this.watch(i.userId);
      const v = venueOf(i.market);
      const adapter = this.venue(v);
      const held = (await adapter.holdings(i.userId, [i.market])).find(h => h.market.toLowerCase() === i.market.toLowerCase());
      if (!held || BigInt(held.sizeRaw) <= 0n) throw new MirrorError(409, 'This position is no longer open. Refresh your positions.');
      const parts = allocatedHoldings(i.userId, [held]);
      const bookedParts = allocationsFor(i.userId, held);
      const target = markerId ? parts.find(p => p.markerId === markerId) : held;
      if (!target) throw new MirrorError(404, 'That trade is not an open position in your account.');
      const size = BigInt(i.sizeRaw ?? target.sizeRaw);
      if (size <= 0n || size > BigInt(target.sizeRaw)) throw new MirrorError(409, 'Close size exceeds this trade. Refresh your positions.');
      const targets = (markerId ? [target] : parts).filter(p => p.markerId && !p.markerId.startsWith('private:'))
        .map(p => ({ markerId: p.markerId!, size: bookedParts.find(b => b.markerId === p.markerId)?.size.toString() ?? p.sizeRaw }));
      const order = memberOrders.begin({ userId: i.userId, venue: v, market: i.market, kind: 'close', side: held.side,
        leverage: Math.round(held.leverage * 100), marginFraction: 0, cultIds: [], markerId: markerId ?? null,
        requestedNotional: 0, beforeSize: target.sizeRaw, targets });
      try {
        const fill = await adapter.close({ ...i, sizeRaw: size.toString(), side: held.side,
          onRef: ref => { memberOrders.ref(order.id, ref); i.onRef?.(ref); } });
        memberOrders.ref(order.id, { rq: fill.requestId, accountId: members.get(i.userId)?.perplAccountId ?? undefined, txHash: fill.txHash ?? undefined });
        await this.bookOwnFill(order.id, fill);
        return { ...fill, markerId };
      } catch (e) { memberOrders.failed(order.id); throw e; }
    });
    const mirrorIds = markerId?.startsWith('mirror:') ? [markerId.slice(7)] : !markerId
      ? mirrors.forUser(i.userId, ['open']).filter(m => trades.get(m.tradeId)?.market === i.market.toLowerCase()).map(m => m.id).sort() : [];
    const locked = (index: number): Promise<Fill> => index === mirrorIds.length ? run() : this.inLane(mirrorIds[index]!, () => locked(index + 1));
    return locked(0);
  }

  private async onOwnPerplOrder(o: Order) {
    const order = memberOrders.perpl(o.acc, o.rq);
    if (!order || !(o.fs > 0) || o.st === OrderStatus.Pending || o.st === OrderStatus.Open) return;
    const { getMarket, scale } = await import('../perpl/context.js');
    const market = await getMarket(o.mkt);
    const size = scale.unsize(o.fs, market);
    const price = scale.unprice(o.fp, market);
    await this.bookOwnFill(order.id, { venue: 'perpl', market: String(o.mkt), side: order.side, sizeRaw: String(o.fs),
      size, priceAusd: price, notionalAusd: size * price, requestId: o.rq, orderId: o.oid, txHash: o.at?.txid });
  }

  private async recoverOwnOrders(userId: string) {
    if (!getDb().prepare('SELECT 1 FROM member_orders WHERE user_id = ? AND account_id IS NOT NULL LIMIT 1').get(userId)) return;
    const { restFor } = await import('../accounts/lifecycle.js');
    const history = await restFor(userId).orderHistory(200);
    for (const order of history.d) await this.onOwnPerplOrder(order);
  }

  // Both the websocket and HTTP result may report a fill. Book only the
  // increase in confirmed cumulative quantity, never the requested size.
  async bookOwnFill(id: string, fill: Fill): Promise<void> {
    return this.inLane('fill:' + id, async () => {
      const order = memberOrders.get(id);
      if (!order) throw new MirrorError(404, 'Trade request not found.');
      if (fill.venue !== order.venue || fill.market.toLowerCase() !== order.market || fill.side !== order.side) throw new MirrorError(409, 'Fill does not match this trade request.');
      const cumulative = BigInt(fill.sizeRaw);
      const booked = BigInt(order.bookedSize);
      if (cumulative <= 0n) throw new MirrorError(409, 'The order did not fill. Refresh your positions before trying again.');
      if (cumulative <= booked) return;
      if (!(fill.priceAusd > 0) || !Number.isFinite(fill.priceAusd)) throw new MirrorError(503, 'Fill price unavailable; refresh your positions shortly.');
      if (order.kind === 'open') {
        const existing = trades.get(order.allocationId);
        const delta = cumulative - booked;
        const perRaw = fill.size / Number(cumulative);
        const deltaCost = fill.notionalAusd - order.bookedNotional;
        const deltaPrice = deltaCost > 0 && perRaw > 0 ? deltaCost / (Number(delta) * perRaw) : null;
        if (existing && !existing.closedAt) {
          const size = BigInt(existing.size) + delta;
          const entry = existing.entryPrice != null && deltaPrice != null
            ? (existing.entryPrice * Number(BigInt(existing.size)) + deltaPrice * Number(delta)) / Number(size) : null;
          await memberOrders.commitFill(id, cumulative.toString(), fill.notionalAusd, () => this.leaderResized(existing, size, entry, undefined, true));
        } else {
          const tradeId = existing?.closedAt ? randomUUID() : order.allocationId;
          await this.leaderOpened({ id: tradeId, booking: { orderId: id, size: cumulative.toString(), notional: fill.notionalAusd },
            keepPrivate: true, cultIds: existing?.closedAt || order.allocationId !== id ? [] : order.cultIds, venue: order.venue, userId: order.userId,
            market: order.market, side: order.side, sizeRaw: delta.toString(), entryPriceAusd: deltaPrice,
            leverageHundredths: order.leverage, marginFraction: order.marginFraction * Math.min(1, fill.notionalAusd / order.requestedNotional),
            accountId: order.accountId ?? undefined, netPositionId: this.perplPositions.get(order.userId + ':' + order.market)?.pid,
            detectedLateBySeconds: Math.max(0, (Date.now() - order.createdAt) / 1000),
            openTx: fill.txHash ?? order.txHash });
        }
      } else {
        const before = BigInt(order.beforeSize);
        if (before <= 0n) throw new MirrorError(409, 'Close allocation unavailable. Refresh your positions.');
        const done = cumulative > before ? before : cumulative;
        for (const target of order.targets) {
          const size = BigInt(target.size);
          await memberOrders.applyTarget(id, target.markerId, size * done / before, amount => this.reduceMarker(target.markerId, order.userId, amount, fill));
        }
      }
      memberOrders.booked(id, cumulative.toString(), fill.notionalAusd);
    });
  }

  private reduceMarker(markerId: string, userId: string, amount: bigint, fill?: Fill): Promise<void> {
    if (amount <= 0n) return Promise.resolve();
    const [kind, id] = markerId.split(':');
    if (kind === 'trade') {
      const t = trades.get(id!);
      if (!t || t.userId !== userId || t.closedAt) return Promise.resolve();
      const after = BigInt(t.size) > amount ? BigInt(t.size) - amount : 0n;
      return after === 0n ? this.closeTrade(t, false) : this.leaderResized(t, after, t.entryPrice, undefined, true);
    } else if (kind === 'mirror') {
      const m = mirrors.get(id!);
      if (!m || m.userId !== userId || m.status !== 'open') return Promise.resolve();
      const before = BigInt(m.size ?? '0');
      const after = before > amount ? before - amount : 0n;
      const patch = { size: after === 0n ? m.size : after.toString(), notionalUsd: m.notionalUsd == null ? null : after === 0n ? m.notionalUsd : m.notionalUsd * Number(after) / Number(before),
        closeOid: fill?.orderId ?? m.closeOid, closeTx: fill?.txHash ?? m.closeTx, error: null };
      if (after === 0n) {
        const closed = mirrors.transition(m.id, 'open', 'closed', patch);
        if (closed) this.emit('mirror', closed);
      } else { mirrors.patch(m.id, patch); this.emit('mirror', mirrors.get(m.id)!); }
    } else if (kind === 'stack') {
      const db = getDb();
      const s = db.prepare("SELECT size, notional_usd FROM stacks WHERE id = ? AND user_id = ? AND status = 'open'")
        .get(id!, userId) as { size: string; notional_usd: number | null } | undefined;
      if (!s) return Promise.resolve();
      const before = BigInt(s.size);
      const after = before > amount ? before - amount : 0n;
      db.prepare('UPDATE stacks SET size = ?, notional_usd = ?, status = ? WHERE id = ?')
        .run(after.toString(), s.notional_usd == null ? null : s.notional_usd * Number(after) / Number(before), after === 0n ? 'closed' : 'open', id!);
    }
    return Promise.resolve();
  }

  private async reduceExternal(userId: string, v: Venue, market: string, side: TradeSide, after: bigint, before: bigint) {
    const parts: { markerId: string; size: bigint }[] = [];
    for (const m of mirrors.forUser(userId, ['open'])) {
      const t = trades.get(m.tradeId);
      if (t?.venue === v && t.market === market && t.side === side) parts.push({ markerId: 'mirror:' + m.id, size: BigInt(m.size ?? '0') });
    }
    const stacks = getDb().prepare("SELECT id, size FROM stacks WHERE user_id = ? AND venue = ? AND market = ? AND side = ? AND status = 'open'")
      .all(userId, v, market, side) as { id: string; size: string }[];
    parts.push(...stacks.map(s => ({ markerId: 'stack:' + s.id, size: BigInt(s.size ?? '0') })));
    parts.push(...trades.openOnMarket(userId, v, market).filter(t => t.side === side).map(t => ({ markerId: 'trade:' + t.id, size: BigInt(t.size) })));
    for (const p of parts) await this.reduceMarker(p.markerId, userId, after === 0n ? p.size : p.size * (before - after) / before);
  }

  async leaderOpened(e: LeaderOpen): Promise<LeaderTrade | null> {
    // Every cult the trader is an admin of, or only the ones they posted this
    // trade to. Only admins share trades with a cult; anyone else's trade is
    // theirs alone (no chart, no notice, no copies).
    if (e.id && trades.get(e.id)) return trades.get(e.id);
    const picked = e.cultIds ?? takeAudience(e.userId, e.venue, e.market);
    const clanIds = tradeCults({ cultIds: picked ?? null }, clans.adminCultIds(e.userId));
    if (clanIds.length === 0 && !e.keepPrivate) return null;
    const db = getDb();
    if (e.id) db.exec('BEGIN IMMEDIATE');
    let trade: LeaderTrade;
    try { trade = trades.insert({
      id: e.id ?? randomUUID(),
      venue: e.venue,
      userId: e.userId,
      accountId: e.accountId ?? null,
      market: e.market,
      side: e.side,
      positionId: e.positionId ?? null,
      netPositionId: e.netPositionId ?? null,
      size: e.sizeRaw,
      entryPrice: e.entryPriceAusd,
      leverage: e.leverageHundredths,
      marginFraction: e.marginFraction,
      openTx: e.openTx ?? null,
      openedAt: Date.now(),
      // Stored explicitly: the cults it went to when it opened (a later
      // admin change doesn't move it).
      cultIds: clanIds,
    });
      if (e.booking) {
        memberOrders.assignAllocation(e.booking.orderId, trade.id);
        memberOrders.booked(e.booking.orderId, e.booking.size, e.booking.notional);
      } else if (e.id && memberOrders.get(e.id)) memberOrders.booked(e.id, e.sizeRaw);
      if (e.id) db.exec('COMMIT');
    } catch (error) { if (e.id) db.exec('ROLLBACK'); throw error; }
    this.emit('trade', trade);

    const skipUntil = Date.now() + this.cfg.optOutSeconds * 1000;
    const maxAge = this.cfg.maxLeaderAgeSeconds ?? 120;
    const stale = (e.detectedLateBySeconds ?? 0) > maxAge;
    const seen = new Set<string>([e.userId]);
    for (const clanId of clanIds) {
      for (const m of clans.members(clanId)) {
        if (seen.has(m.userId)) continue; // one mirror per follower even across shared clans
        if (!m.policy.enabled) continue;
        seen.add(m.userId);
        const why = await this.cannotTrade(m.userId, e.venue);
        const followExits = clans.membership(clanId, m.userId)?.policy.followExits ?? m.policy.followExits;
        if (why) {
          // Tell the member why they weren't mirrored instead of silently skipping them.
          const skipped = mirrors.insertPending({ tradeId: trade.id, clanId, userId: m.userId, skipUntil, followExits });
          this.emit('mirror', mirrors.transition(skipped.id, 'pending', 'cancelled', { error: why })!);
          continue;
        }
        const mirror = mirrors.insertPending({ tradeId: trade.id, clanId, userId: m.userId, skipUntil, followExits });
        if (stale) {
          this.emit('mirror', mirrors.transition(mirror.id, 'pending', 'cancelled', { error: `leader trade detected ${e.detectedLateBySeconds}s late (backend was catching up); not mirrored at a stale price` })!);
          continue;
        }
        this.emit('mirror', mirror);
        this.schedule(mirror);
      }
    }
    return trade;
  }

  // Why this member can't be mirrored on this venue right now (null = they can).
  // Perpl: an enrolled key, account and order forwarding.
  // Nad.fun: a signer the backend may use,
  // i.e. the backend's Privy signer attached to their wallet under their
  // current policy (or a registered test key). An injected venue (tests)
  // decides for itself.
  private async cannotTrade(userId: string, v: Venue): Promise<string | null> {
    const m = members.get(userId);
    if (!m) return 'unknown member';
    if (this.deps.venue) return null;
    if (v === 'perpl') {
      if (!m.perplAccountId) return 'Perpl setup not finished: create your Perpl account';
      if (!members.credentials(userId)) return 'Perpl setup not finished: enroll your trading key';
      if (!m.forwarding) return 'Perpl setup not finished: enable order forwarding';
      return null;
    }
    if (hasSignerOverride(userId)) return null;
    if (!m.privyWalletId) return 'no Privy wallet on file';
    const st = await backendSignerStatus(userId).catch(() => null);
    if (!st) return null; // Privy unreachable: let Privy itself decide at signing time
    if (!st.attached) return 'backend signer not added to the wallet (finish clan setup)';
    if (!st.policyCurrent) return 'backend signer is on an outdated policy (re-approve your caps)';
    return null;
  }

  // The leader's trade is now `sizeRaw` (was trade.size). Every open mirror
  // follows by the same ratio of its own size. Mirrors still pending or
  // mid-submit pick the change up themselves (see fire), so none is counted twice.
  leaderResized(trade: LeaderTrade, sizeRaw: bigint, entryPriceAusd: number | null, detectedLateBySeconds?: number, exact = false): Promise<void> {
    const before = BigInt(trade.size);
    if (before <= 0n || sizeRaw === before) return Promise.resolve();
    if (sizeRaw <= 0n || (!exact && sizeRaw * 100n <= before)) return this.closeTrade(trade);
    const ratio = Number((sizeRaw * 1_000_000n) / before) / 1_000_000;
    // No await from here to the end of the loop: the resize and the set of
    // open mirrors it applies to have to be read as one step.
    trades.resize(trade.id, sizeRaw.toString(), entryPriceAusd);
    this.emit('tradeChanged', trades.get(trade.id)!, ratio);
    for (const m of mirrors.forTrade(trade.id)) {
      if (m.status === 'open') this.queueAdjustment(trade, m, ratio, detectedLateBySeconds);
    }
    return Promise.resolve();
  }

  private queueAdjustment(trade: LeaderTrade, m: Mirror, ratio: number, detectedLateBySeconds?: number) {
    const kind = ratio > 1 ? 'add' : 'reduce';
    if (kind === 'reduce' && mirrors.get(m.id)?.followExits === false) return;
    const a = adjustments.insert({
      mirrorId: m.id,
      tradeId: trade.id,
      clanId: m.clanId,
      userId: m.userId,
      kind,
      ratio,
      // Adding spends the member's money, so they get the skip window. Partly
      // exiting only takes risk off, so it goes out straight away like an exit.
      skipUntil: kind === 'add' ? Date.now() + this.cfg.optOutSeconds * 1000 : Date.now(),
    });
    if (kind === 'add' && (detectedLateBySeconds ?? 0) > (this.cfg.maxLeaderAgeSeconds ?? 120)) {
      this.emit('adjustment', adjustments.transition(a.id, 'pending', 'cancelled', { error: `leader's add detected ${detectedLateBySeconds}s late; not mirrored at a stale price` })!);
      return;
    }
    this.emit('adjustment', a);
    this.scheduleAdjustment(a);
  }

  skipAdjustment(id: string, userId: string): Adjustment {
    const a = adjustments.get(id);
    if (!a || a.userId !== userId) throw new MirrorError(404, 'adjustment not found');
    if (a.kind !== 'add') throw new MirrorError(409, 'partial exits follow the leader straight away');
    if (a.status !== 'pending') throw new MirrorError(409, `adjustment is ${a.status}, not pending`);
    if (Date.now() >= a.skipUntil) throw new MirrorError(409, 'skip window has passed');
    const updated = adjustments.transition(id, 'pending', 'skipped');
    if (!updated) throw new MirrorError(409, 'adjustment already moved on');
    this.unschedule(`adj:${id}`);
    this.emit('adjustment', updated);
    return updated;
  }

  // Leaving cancels new entries and adds. Open copies retain their exit choice.
  memberLeft(clanId: string, userId: string) {
    for (const m of mirrors.forClan(clanId, ['pending'])) {
      if (m.userId === userId) this.cancelPending(m.id, 'member left the clan');
    }
    for (const a of adjustments.byStatus('pending')) {
      if (a.clanId !== clanId || a.userId !== userId || a.kind !== 'add') continue;
      const updated = adjustments.transition(a.id, 'pending', 'cancelled', { error: 'member left the clan' });
      if (!updated) continue;
      this.unschedule(`adj:${a.id}`);
      this.emit('adjustment', updated);
    }
  }

  setFollowExits(clanId: string, userId: string, enabled: boolean) {
    clans.setFollowExits(clanId, userId, enabled);
    for (const m of mirrors.forClan(clanId, ['pending', 'submitting', 'open'])) {
      if (m.userId !== userId) continue;
      // Re-enabling must not retroactively sell a copy the member kept after an exit.
      if (enabled && trades.get(m.tradeId)?.closedAt) continue;
      mirrors.patch(m.id, { followExits: enabled });
      this.emit('mirror', mirrors.get(m.id)!);
    }
    if (!enabled) for (const a of adjustments.byStatus('pending')) {
      if (a.clanId !== clanId || a.userId !== userId || a.kind !== 'reduce') continue;
      const updated = adjustments.transition(a.id, 'pending', 'cancelled', { error: 'member turned off Follow exits' });
      if (!updated) continue;
      this.unschedule(`adj:${a.id}`);
      this.emit('adjustment', updated);
    }
  }

  private scheduleAdjustment(a: Adjustment) {
    const key = `adj:${a.id}`;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.inLane(a.mirrorId, () => this.runAdjustment(a.id)).catch((e) => this.log('adjust', e));
      }, Math.max(0, a.skipUntil - Date.now())),
    );
  }

  // Bring one open mirror in step with its leader's change. Runs in the
  // mirror's lane, so adjustments and the final close never overlap and each
  // one starts from the size the previous one left.
  private async runAdjustment(id: string) {
    const a = adjustments.transition(id, 'pending', 'submitting');
    if (!a) return;
    const trade = trades.get(a.tradeId)!;
    const m = mirrors.get(a.mirrorId)!;
    const done = (to: 'done' | 'cancelled' | 'failed', patch: Parameters<typeof adjustments.patch>[1] = {}) =>
      this.emit('adjustment', adjustments.transition(id, 'submitting', to, patch)!);
    if (trade.closedAt) return done('cancelled', { error: 'leader already closed; the exit covers it' });
    if (m.status !== 'open' || !m.size) return done('cancelled', { error: `mirror is ${m.status}` });
    if (a.kind === 'reduce' && m.followExits === false) return done('cancelled', { error: 'member turned off Follow exits' });

    let sent = false;
    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    const onRef = (kind: 'mirror_add' | 'mirror_reduce') => (ref: { rq?: number; accountId?: number; txHash?: string; wallet?: string }) => {
      sent = true;
      recordRef(ref, kind, id);
      if (ref.rq != null) adjustments.patch(id, { rq: ref.rq });
    };
    try {
      const adapter = this.venue(trade.venue);
      if (!this.deps.venue && trade.venue === 'perpl' && !members.credentials(m.userId)) throw new NotSized('Perpl credentials unavailable; position status is unconfirmed');
      if (a.kind === 'add') {
        const why = await this.cannotTrade(m.userId, trade.venue);
        if (why) {
          this.attempts.delete(id);
          return done('cancelled', { error: why });
        }
      }
      const held = (await adapter.holdings(m.userId, [trade.market]))[0];
      if (!held) {
        this.emit('mirror', mirrors.transition(m.id, 'open', 'closed', { error: 'member had already exited this position' })!);
        return done('cancelled', { error: 'member had already exited' });
      }
      const size = BigInt(m.size);
      const keepMillionths = BigInt(Math.round(a.ratio * 1_000_000));

      if (a.kind === 'reduce') {
        if (mirrors.get(m.id)?.followExits === false) return done('cancelled', { error: 'member turned off Follow exits' });
        const own = allocatedHoldings(m.userId, [held]).find(h => h.markerId === 'mirror:' + m.id);
        const available = BigInt(own?.sizeRaw ?? '0');
        const sell = available - (available * keepMillionths) / 1_000_000n;
        if (sell <= 0n) return done('done', { sizeDelta: '0', error: 'rounds to nothing at this size' });
        adjustments.patch(id, { beforeSize: size.toString(), availableSize: available.toString() });
        const fill = await adapter.close({ userId: m.userId, market: trade.market, sizeRaw: sell.toString(), side: trade.side, onRef: onRef('mirror_reduce') });
        if (BigInt(fill.sizeRaw) <= 0n) throw new Error('partial exit did not fill');
        this.attempts.delete(id);
        const sold = BigInt(fill.sizeRaw) > available ? available : BigInt(fill.sizeRaw);
        this.applyReduce(a, m, size * sold / available, { sizeDelta: sold.toString(), notionalUsd: fill.notionalAusd, oid: fill.orderId ?? null, tx: fill.txHash ?? null });
        return;
      }

      // Add: the member's mirror x (ratio - 1), valued at mark, under the same caps as a new mirror.
      const membership = clans.membership(m.clanId, m.userId);
      if (!membership) throw new NotSized('member is no longer in the clan');
      if (!membership.policy.enabled) throw new NotSized('mirroring is disabled by the member');
      const perRaw = Number(held.sizeRaw) > 0 ? held.size / Number(held.sizeRaw) : 0;
      const want = Number(size) * perRaw * (a.ratio - 1) * held.markPriceAusd;
      const leverage = Math.min(trade.leverage / 100, await adapter.maxLeverage(trade.market));
      const sized = capAdd(want, leverage, await adapter.freeBalanceAusd(m.userId), membership.policy, this.cfg.minMirrorAusd ?? 1);
      if (!sized.ok) throw new NotSized(`not sized: ${sized.reason}`);
      const fill = await adapter.open({ userId: m.userId, market: trade.market, side: trade.side, notionalAusd: sized.notionalUsd, leverage, onRef: onRef('mirror_add') });
      if (BigInt(fill.sizeRaw) <= 0n) throw new Error('add order did not fill');
      this.attempts.delete(id);
      this.applyAdd(a, m, BigInt(fill.sizeRaw), leverage, {
        notionalUsd: fill.notionalAusd,
        oid: fill.orderId ?? null,
        tx: fill.txHash ?? null,
        error: sized.capsApplied.length ? `capped: ${sized.capsApplied.join(',')}` : null,
      });
    } catch (e) {
      const msg = String(e).slice(0, 450);
      if (!sent && !(e instanceof NotSized) && attempt <= MAX_RETRIES) {
        const again = adjustments.transition(id, 'submitting', 'pending', { skipUntil: Date.now() + RETRY_BACKOFF_MS * attempt, error: `retrying (${attempt}/${MAX_RETRIES}): ${msg}` })!;
        this.emit('adjustment', again);
        this.scheduleAdjustment(again);
        return;
      }
      this.attempts.delete(id);
      done('failed', { error: `${sent ? 'failed after sending, not retried: ' : ''}${msg}` });
    }
  }

  // Book a mirror's partial sell: the size and cost basis shrink together
  // (entry price unchanged); selling all of it closes the mirror.
  private applyReduce(a: Adjustment, m: Mirror, sold: bigint, fill: { sizeDelta?: string; notionalUsd: number; oid: number | null; tx: string | null; error?: string | null }) {
    const size = BigInt(m.size ?? '0');
    const left = size > sold ? size - sold : 0n;
    const keep = size > 0n ? Number((left * 1_000_000n) / size) / 1_000_000 : 0;
    mirrors.patch(m.id, { size: left.toString(), notionalUsd: (m.notionalUsd ?? 0) * keep, marginUsd: (m.marginUsd ?? 0) * keep });
    this.emit('adjustment', adjustments.transition(a.id, 'submitting', 'done', { sizeDelta: sold.toString(), ...fill })!);
    this.emit('mirror', left === 0n ? mirrors.transition(m.id, 'open', 'closed', { closeTx: fill.tx, closeOid: fill.oid })! : mirrors.get(m.id)!);
  }

  private applyAdd(a: Adjustment, m: Mirror, bought: bigint, leverage: number, fill: { notionalUsd: number; oid: number | null; tx: string | null; error?: string | null }) {
    mirrors.patch(m.id, {
      size: (BigInt(m.size ?? '0') + bought).toString(),
      notionalUsd: (m.notionalUsd ?? 0) + fill.notionalUsd,
      marginUsd: (m.marginUsd ?? 0) + fill.notionalUsd / leverage,
    });
    this.emit('adjustment', adjustments.transition(a.id, 'submitting', 'done', { sizeDelta: bought.toString(), ...fill })!);
    this.emit('mirror', mirrors.get(m.id)!);
  }

  // ---- crash recovery ------------------------------------------------------------
  //
  // Anything the engine sends is tagged before it leaves, so after a restart
  // every mirror or adjustment caught mid-send can be settled by what actually
  // reached the venue: filled -> booked as if the send had returned; nothing
  // reached it -> tried again if the leader's move is still fresh, else
  // cancelled; still in flight -> looked at again shortly. Mirrors of a trade
  // that closed while we were down are unwound, unless their exit already landed.

  private async reconcileAll() {
    for (const m of mirrors.byStatus('submitting')) await this.guard(`reconcile mirror ${m.id}`, () => this.reconcileMirror(m.id));
    for (const a of adjustments.byStatus('submitting')) await this.guard(`reconcile adjustment ${a.id}`, () => this.reconcileAdjustment(a.id));
    for (const m of mirrors.byStatus('open')) {
      const trade = trades.get(m.tradeId)!;
      if (trade.closedAt && (m.followExits !== false || m.closeRef || m.closeRq != null)) await this.guard(`reconcile exit ${m.id}`, () => this.reconcileExit(m.id));
    }
  }

  private landed(venue: Venue, kind: Parameters<LandedLookup>[1], refId: string, userId: string): Promise<Landed> {
    return (this.deps.landed ?? defaultLanded)(venue, kind, refId, userId);
  }

  private async reconcileMirror(id: string): Promise<void> {
    const m = mirrors.get(id)!;
    if (m.status !== 'submitting') return;
    const trade = trades.get(m.tradeId)!;
    const r = await this.landed(trade.venue, 'mirror_open', m.id, m.userId);
    if (r.state === 'pending') return this.lookAgain(`m:${id}`, () => this.reconcileMirror(id));
    if (r.state === 'filled') {
      const lev = trade.venue === 'perpl' ? trade.leverage / 100 : 1;
      const opened = mirrors.transition(id, 'submitting', 'open', {
        size: r.sizeRaw,
        notionalUsd: r.notionalUsd,
        marginUsd: r.notionalUsd / lev,
        openTx: r.txHash,
        openOid: r.orderId,
        error: 'recovered after a restart',
      })!;
      this.emit('mirror', opened);
      if (trade.closedAt) await this.closeMirror(opened, trade);
      return;
    }
    if (r.state === 'failed') {
      this.emit('mirror', mirrors.transition(id, 'submitting', 'failed', { error: `interrupted by a restart; ${r.reason}` })!);
      return;
    }
    // Nothing reached the venue, so trying again can't double anything up.
    if (!trade.closedAt && Date.now() - trade.openedAt <= this.maxAgeMs()) {
      const again = mirrors.transition(id, 'submitting', 'pending', { skipUntil: Date.now(), error: 'interrupted by a restart before sending; trying again' })!;
      this.emit('mirror', again);
      this.schedule(again);
      return;
    }
    this.emit('mirror', mirrors.transition(id, 'submitting', 'cancelled', { error: 'interrupted by a restart before sending; too late to copy now' })!);
  }

  private async reconcileAdjustment(id: string): Promise<void> {
    const a = adjustments.get(id)!;
    if (a.status !== 'submitting') return;
    const trade = trades.get(a.tradeId)!;
    const m = mirrors.get(a.mirrorId)!;
    const r = await this.landed(trade.venue, a.kind === 'add' ? 'mirror_add' : 'mirror_reduce', id, a.userId);
    if (r.state === 'pending') return this.lookAgain(`a:${id}`, () => this.reconcileAdjustment(id));
    const note = { notionalUsd: r.state === 'filled' ? r.notionalUsd : 0, oid: r.state === 'filled' ? r.orderId : null, tx: r.state === 'filled' ? r.txHash : null, error: 'recovered after a restart' };
    if (r.state === 'filled' && m.status === 'open') {
      if (a.kind === 'reduce') {
        const available = BigInt(a.availableSize ?? m.size ?? '0');
        const before = BigInt(a.beforeSize ?? m.size ?? '0');
        const raw = BigInt(r.sizeRaw);
        const sold = available > 0n ? before * (raw > available ? available : raw) / available : 0n;
        this.applyReduce(a, m, sold, { ...note, sizeDelta: r.sizeRaw });
      }
      else this.applyAdd(a, m, BigInt(r.sizeRaw), trade.venue === 'perpl' ? trade.leverage / 100 : 1, note);
      return;
    }
    if (r.state === 'filled') {
      this.emit('adjustment', adjustments.transition(id, 'submitting', 'done', { ...note, sizeDelta: r.sizeRaw })!);
      return;
    }
    // Reconcile confirmed fills even after an opt-out, but never retry an
    // unsent reduction against the member's current exit choice.
    if (a.kind === 'reduce' && mirrors.get(m.id)?.followExits === false) {
      this.emit('adjustment', adjustments.transition(id, 'submitting', 'cancelled', { error: 'member turned off Follow exits' })!);
      return;
    }
    const retry = a.kind === 'reduce' || (r.state === 'none' && Date.now() - a.createdAt <= this.maxAgeMs());
    if (retry) {
      const again = adjustments.transition(id, 'submitting', 'pending', { skipUntil: Date.now(), error: `interrupted by a restart${r.state === 'failed' ? `; ${r.reason}` : ' before sending'}; trying again` })!;
      this.emit('adjustment', again);
      this.scheduleAdjustment(again);
      return;
    }
    this.emit('adjustment', adjustments.transition(id, 'submitting', r.state === 'failed' ? 'failed' : 'cancelled', { error: `interrupted by a restart; ${r.state === 'failed' ? r.reason : 'too late to copy now'}` })!);
  }

  // The leader closed; this mirror is still open. If its exit already landed
  // (we went down right after sending it), just record that; never sell twice.
  private async reconcileExit(id: string): Promise<void> {
    const m = mirrors.get(id)!;
    const trade = trades.get(m.tradeId)!;
    const r = await this.landed(trade.venue, 'mirror_close', m.closeRef ?? m.id, m.userId);
    if (r.state === 'pending') return this.lookAgain(`x:${id}`, () => this.reconcileExit(id));
    if (r.state === 'filled') {
      this.bookMirrorExit(m, r, true);
      return;
    }
    await this.closeMirror(m, trade);
  }

  private bookMirrorExit(m: Mirror, fill: { sizeRaw: string; orderId?: number | null; txHash?: string | null }, recovered = false) {
    if (m.status !== 'open') return;
    const sameFill = (fill.orderId != null && fill.orderId === m.closeOid) || (fill.txHash != null && fill.txHash === m.closeTx);
    // Older rows have no attempt snapshot. An already-booked legacy fill is
    // ambiguous, so never subtract it again without its cumulative baseline.
    if (!m.closeBeforeSize && sameFill) return;
    const continuing = m.closeRef != null || sameFill;
    const before = BigInt(continuing ? m.closeBeforeSize ?? m.size ?? '0' : m.size ?? '0');
    const requested = BigInt(continuing ? m.closeRequestedSize ?? before.toString() : before.toString());
    const booked = BigInt(continuing ? m.closeBookedSize ?? '0' : '0');
    const raw = BigInt(fill.sizeRaw);
    if (requested <= 0n || raw <= booked) return;
    const cumulative = raw > requested ? requested : raw;
    if (cumulative <= booked) return;
    // The live position can be smaller than our ledger. Apply the confirmed
    // fraction of the requested slice, not an unrelated member's quantity.
    const removed = before * cumulative / requested - before * booked / requested;
    const current = BigInt(m.size ?? '0');
    const after = current > removed ? current - removed : 0n;
    const note = { closeBeforeSize: before.toString(), closeRequestedSize: requested.toString(),
      closeBookedSize: cumulative.toString(), closeTx: fill.txHash ?? null, closeOid: fill.orderId ?? null };
    if (after > 0n) {
      mirrors.patch(m.id, { ...note, size: after.toString(),
        notionalUsd: m.notionalUsd == null ? null : m.notionalUsd * Number(after) / Number(current),
        error: 'close partially filled; remaining size is still open' });
      this.emit('mirror', mirrors.get(m.id)!);
    } else {
      const closed = mirrors.transition(m.id, 'open', 'closed', { ...note, error: recovered ? 'exit recovered after a restart' : null });
      if (closed) this.emit('mirror', closed);
    }
  }

  private lookAgain(key: string, fn: () => Promise<void>): void {
    const k = `look:${key}`;
    const attempt = (this.attempts.get(k) ?? 0) + 1;
    this.attempts.set(k, attempt);
    if (attempt > LOOK_AGAIN_MAX) return void this.log(key, 'still in flight after a restart; check it by hand');
    this.timers.set(
      k,
      setTimeout(() => {
        this.timers.delete(k);
        void this.guard(key, fn);
      }, LOOK_AGAIN_MS),
    );
  }

  private maxAgeMs() {
    return (this.cfg.maxLeaderAgeSeconds ?? 120) * 1000;
  }

  private async guard(where: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.log(where, e);
    }
  }

  // One mirror's adjustments and close run one after another.
  private inLane<T>(mirrorId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.lanes.get(mirrorId) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.lanes.set(mirrorId, run);
    void run.catch(() => undefined).finally(() => {
      if (this.lanes.get(mirrorId) === run) this.lanes.delete(mirrorId);
    });
    return run;
  }

  closeTrade(trade: LeaderTrade, waitForCopies = true): Promise<void> {
    if (trades.get(trade.id)?.closedAt) return Promise.resolve();
    trades.markClosed(trade.id);
    this.emit('tradeClosed', { ...trade, closedAt: Date.now() });
    // A pending add would buy into a trade that's over; the exit below covers pending reductions.
    for (const a of adjustments.forTrade(trade.id, ['pending'])) {
      const updated = adjustments.transition(a.id, 'pending', 'cancelled', { error: 'leader closed' });
      if (!updated) continue;
      this.unschedule(`adj:${a.id}`);
      this.emit('adjustment', updated);
    }
    const toClose: Mirror[] = [];
    for (const m of mirrors.forTrade(trade.id)) {
      if (m.status === 'pending') {
        this.unschedule(m.id);
        this.emit('mirror', mirrors.transition(m.id, 'pending', 'cancelled', { error: 'leader closed before mirror fired' })!);
      } else if (m.status === 'open' && m.followExits !== false) {
        toClose.push(m);
      }
    }
    // Each follower is their own wallet/account, so unwind them in parallel:
    // the last follower shouldn't exit later just because of the clan's size.
    const exits = Promise.all(toClose.map((m) => this.closeMirror(m, trade)));
    if (waitForCopies) return exits.then(() => undefined);
    void exits.catch(error => this.log('follower exit', error));
    return Promise.resolve();
  }

  // Stop a pending mirror for a reason other than the member's own skip.
  cancelPending(mirrorId: string, reason: string) {
    const updated = mirrors.transition(mirrorId, 'pending', 'cancelled', { error: reason });
    if (!updated) return;
    this.unschedule(mirrorId);
    this.emit('mirror', updated);
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
    // Set the moment the venue hands back a ref, i.e. right before an order or
    // tx leaves. Until then a failure provably sent nothing, so a retry can't
    // double up a position.
    let sent = false;
    const attempt = (this.attempts.get(m.id) ?? 0) + 1;
    this.attempts.set(m.id, attempt);
    const factorUsed = sizeFactor(trade);
    try {
      const adapter = this.venue(trade.venue);
      const membership = clans.membership(m.clanId, m.userId);
      if (!membership) throw new NotSized('member is no longer in the clan');
      if (!membership.policy.enabled) throw new NotSized('mirroring is disabled by the member');
      const why = await this.cannotTrade(m.userId, trade.venue);
      if (why) {
        this.attempts.delete(m.id);
        this.emit('mirror', mirrors.transition(m.id, 'submitting', 'cancelled', { error: why })!);
        return;
      }
      const sizing = mirrorNotional(
        {
          // If the leader added or partly exited during the skip window, size to where they are now.
          leaderMarginFraction: trade.marginFraction * factorUsed,
          leaderLeverage: trade.leverage / 100,
          marketMaxLeverage: await adapter.maxLeverage(trade.market),
          followerFreeBalanceUsd: await adapter.freeBalanceAusd(m.userId),
          policy: membership.policy,
        },
        this.cfg.minMirrorAusd ?? 1,
      );
      if (!sizing.ok) throw new NotSized(`not sized: ${sizing.reason}`);

      const fill = await adapter.open({
        userId: m.userId,
        market: trade.market,
        side: trade.side,
        notionalAusd: sizing.notionalUsd,
        leverage: sizing.leverage,
        onRef: (ref) => {
          sent = true;
          recordRef(ref, 'mirror_open', m.id);
          if (ref.rq != null) mirrors.patch(m.id, { openRq: ref.rq });
        },
      });
      if (BigInt(fill.sizeRaw) <= 0n) throw new Error('copy order did not fill');
      this.attempts.delete(m.id);
      const updated = mirrors.transition(m.id, 'submitting', 'open', {
        marginUsd: sizing.marginUsd,
        notionalUsd: fill.notionalAusd,
        size: fill.sizeRaw,
        capApplied: sizing.capsApplied.join(','),
        openOid: fill.orderId ?? null,
        openTx: fill.txHash ?? null,
      })!;
      this.emit('mirror', updated);
      const now = trades.get(trade.id)!;
      if (now.closedAt) {
        await this.closeMirror(updated, trade); // leader left while we filled
      } else if (Math.abs(sizeFactor(now) / factorUsed - 1) > 0.001) {
        // Leader added or partly exited while this was filling: catch up. Read
        // in the same step as the flip to open, so leaderResized can't also count it.
        this.queueAdjustment(now, updated, sizeFactor(now) / factorUsed);
      }
    } catch (e) {
      const msg = String(e).slice(0, 450);
      if (!sent && !(e instanceof NotSized) && attempt <= MAX_RETRIES) {
        // Transient and nothing left: back to pending, try again shortly.
        const again = mirrors.transition(m.id, 'submitting', 'pending', { skipUntil: Date.now() + RETRY_BACKOFF_MS * attempt, error: `retrying (${attempt}/${MAX_RETRIES}): ${msg}` })!;
        this.emit('mirror', again);
        this.schedule(again);
        return;
      }
      this.attempts.delete(m.id);
      this.emit('mirror', mirrors.transition(m.id, 'submitting', 'failed', { error: `${sent ? 'failed after sending, not retried: ' : ''}${msg}` })!);
    }
  }

  private closeMirror(m: Mirror, trade: LeaderTrade) {
    return this.inLane(m.id, async () => {
      const now = mirrors.get(m.id);
      if (now?.status === 'open' && now.followExits !== false) await this.closeMirrorNow(now, trade);
    });
  }

  private async closeMirrorNow(m: Mirror, trade: LeaderTrade) {
    const adapter = this.venue(trade.venue);
    if (!this.deps.venue && trade.venue === 'perpl' && !members.credentials(m.userId)) {
      mirrors.patch(m.id, { error: 'close failed: Perpl credentials unavailable; position status is unconfirmed' });
      this.emit('mirror', mirrors.get(m.id)!);
      return;
    }
    // If the member already got out on their own, there's nothing to unwind.
    const held = await adapter.holdings(m.userId, [trade.market]).catch(() => null);
    if (mirrors.get(m.id)?.followExits === false) return;
    if (held && held.length === 0) {
      this.emit('mirror', mirrors.transition(m.id, 'open', 'closed', { error: 'member had already exited this position' })!);
      return;
    }
    try {
      if (!held) throw new Error('position status is unconfirmed; retry once the venue is available');
      const holding = held.find(h => h.market.toLowerCase() === trade.market && h.side === trade.side);
      if (!holding) throw new Error('position direction changed; refresh before closing this copy');
      const own = allocatedHoldings(m.userId, [holding]).find(h => h.markerId === 'mirror:' + m.id);
      if (!own || BigInt(own.sizeRaw) <= 0n) throw new Error('copy size is unconfirmed; refresh before closing');
      const wanted = BigInt(own.sizeRaw);
      const closeRef = randomUUID();
      mirrors.patch(m.id, { closeRef, closeBeforeSize: m.size, closeRequestedSize: wanted.toString(),
        closeBookedSize: '0', closeRq: null, closeOid: null, closeTx: null });
      const fill = await adapter.close({
        userId: m.userId,
        market: trade.market,
        sizeRaw: wanted.toString(),
        side: trade.side,
        onRef: (ref) => {
          recordRef(ref, 'mirror_close', closeRef);
          if (ref.rq != null) mirrors.patch(m.id, { closeRq: ref.rq });
        },
      });
      const filled = BigInt(fill.sizeRaw);
      if (filled <= 0n) throw new Error('exit order did not fill');
      this.bookMirrorExit(mirrors.get(m.id)!, fill);
    } catch (e) {
      mirrors.patch(m.id, { error: `close failed: ${String(e).slice(0, 400)}` });
      this.emit('mirror', mirrors.get(m.id)!);
    }
  }

  // After a restart: re-arm what was waiting, and settle what was mid-send
  // (in the background, so a slow venue doesn't hold up startup).
  private async recover() {
    for (const m of mirrors.byStatus('pending')) this.schedule(m);
    for (const a of adjustments.byStatus('pending')) this.scheduleAdjustment(a);
    this.recovering = this.reconcileAll();
  }

  // Resolves once the post-restart reconcile pass is done (tests, health).
  recovered(): Promise<void> {
    return this.recovering;
  }

  private log(where: string, e: unknown) {
    console.error(`[mirror] ${where}:`, e);
  }
}


const MAX_RETRIES = 2;
const LOOK_AGAIN_MS = numEnv('MIRROR_RECONCILE_RECHECK_MS', 15_000);
const LOOK_AGAIN_MAX = 40; // ~10 minutes of rechecks for a tx still in flight
const RETRY_BACKOFF_MS = numEnv('MIRROR_RETRY_BACKOFF_MS', 3000);

// A mirror refused by the rules (too small, disabled, left the clan). Not transient.
class NotSized extends Error {}

// Cap a follower's add the way a new mirror is capped: the dollar cap per
// trade, and the margin can't take more than balancePercentCap of what's free.
export function capAdd(wantNotionalUsd: number, leverage: number, freeUsd: number, policy: { balancePercentCap: number; maxUsdPerTrade: number }, minNotionalUsd: number) {
  const caps: string[] = [];
  let notionalUsd = wantNotionalUsd;
  if (!(notionalUsd > 0)) return { ok: false as const, reason: 'nothing to add', notionalUsd: 0, capsApplied: caps };
  if (notionalUsd > policy.maxUsdPerTrade) {
    notionalUsd = policy.maxUsdPerTrade;
    caps.push('max_usd_per_trade');
  }
  const maxMargin = Math.max(0, freeUsd) * (policy.balancePercentCap / 100);
  if (notionalUsd / leverage > maxMargin) {
    notionalUsd = maxMargin * leverage;
    caps.push('balance_percent_cap');
  }
  if (notionalUsd < minNotionalUsd) return { ok: false as const, reason: `add of $${notionalUsd.toFixed(2)} is under the $${minNotionalUsd} minimum`, notionalUsd, capsApplied: caps };
  return { ok: true as const, notionalUsd, capsApplied: caps };
}

export class MirrorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
