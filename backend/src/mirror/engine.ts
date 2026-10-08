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
import { PositionSide, PositionStatus, type Position } from '../perpl/types.js';
import { monPriceAusd } from '../prices.js';
import { clans } from '../store/clans.js';
import { members } from '../store/members.js';
import { venue as defaultVenue, type TradeSide, type Venue, type VenueAdapter } from '../venues/index.js';
import { isEngineOrder, isEngineTx, recordRef } from './origin.js';
import { adjustments, mirrors, sizeFactor, tradeCults, trades, type Adjustment, type LeaderTrade, type Mirror } from './repo.js';
import { takeAudience } from './audience.js';
import { leaderDollarFraction, mirrorNotional } from './sizing.js';
import { landed as defaultLanded, type Landed, type LandedLookup } from './reconcile.js';
import { erc20Abi } from '../chain/exchange.js';
import { GAS_RESERVE_WEI } from '../venues/nadfun.js';

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
    this.watchingPerpl.add(userId);
    session.on('position', (p) => void this.onPerplPosition(userId, session, p).catch((e) => this.log('perpl position', e)));
    session.on('positionClosed', (p) => void this.onPerplClosed(userId, p).catch((e) => this.log('perpl close', e)));
  }

  // ---- leader detection: Perpl ---------------------------------------------

  private async onPerplPosition(userId: string, session: TradingSession, p: Position) {
    if (p.sr === SR_INCREASED || p.sr === SR_DECREASED) return this.onPerplResized(p);
    if (p.sr !== SR_OPENED && p.sr !== SR_INVERTED) return;
    this.perplSeen.set(`${p.acc}:${p.pid}`, BigInt(p.s));
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

  // The leader grew or shrank a position they lead. Only their own orders
  // count: a mirror or stack of someone else's trade can land on the same
  // Perpl position, so their share is tracked apart from the position's total.
  private async onPerplResized(p: Position) {
    const key = `${p.acc}:${p.pid}`;
    const trade = trades.byPosition(p.acc, p.pid);
    const total = BigInt(p.s);
    const seen = this.perplSeen.get(key) ?? (trade ? BigInt(trade.size) : total);
    this.perplSeen.set(key, total);
    if (!trade || trade.closedAt || total === seen) return; // not a trade we lead, or a replay
    if (isEngineOrder(p.acc, p.rq)) return;
    const own = BigInt(trade.size) + (total - seen);
    if (own <= 0n) return this.closeTrade(trade);
    const { getMarket, scale } = await import('../perpl/context.js');
    await this.leaderResized(trade, own, scale.unprice(p.ep, await getMarket(p.mkt)));
  }

  private async onPerplClosed(userId: string, p: Position) {
    if (p.st === PositionStatus.Liquidated) this.emit('liquidation', userId, p);
    this.perplSeen.delete(`${p.acc}:${p.pid}`);
    const trade = trades.byPosition(p.acc, p.pid) ?? trades.openFor(userId, 'perpl', String(p.mkt));
    if (trade && !trade.closedAt) await this.closeTrade(trade);
  }

  // ---- leader detection: Nad.fun --------------------------------------------

  private async onNadTrade(t: NadTradeEvent) {
    if (isEngineTx(t.txHash)) return; // our own mirror/stack
    const member = members.byWallet(t.wallet);
    if (!member) return;
    const open = trades.openFor(member.userId, 'nadfun', t.token);

    const lateBy = t.blockTime > 0 ? Math.max(0, Math.round((Date.now() - t.blockTime) / 1000)) : undefined;

    if (t.side === 'buy' && open) {
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
    const before = BigInt(open.size);
    const after = before > t.tokenAmount ? before - t.tokenAmount : 0n;
    const { tokenBalance } = await import('../nadfun/trading.js');
    const heldAtBlock = await tokenBalance(t.token, t.wallet, t.blockNumber).catch(() => null);
    if (after * 100n <= before || heldAtBlock === 0n) return this.closeTrade(open);
    await this.leaderResized(open, after, open.entryPrice);
  }

  // ---- shared pipeline ---------------------------------------------------------

  async leaderOpened(e: LeaderOpen): Promise<LeaderTrade | null> {
    // Every cult the trader is an admin of, or only the ones they posted this
    // trade to. Only admins share trades with a cult; anyone else's trade is
    // theirs alone (no chart, no notice, no copies).
    const picked = takeAudience(e.userId, e.venue, e.market);
    const clanIds = tradeCults({ cultIds: picked ?? null }, clans.adminCultIds(e.userId));
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
      // Stored explicitly: the cults it went to when it opened (a later
      // admin change doesn't move it).
      cultIds: clanIds,
    });
    this.emit('trade', trade);

    const skipUntil = Date.now() + this.cfg.optOutSeconds * 1000;
    const maxAge = this.cfg.maxLeaderAgeSeconds ?? 120;
    const stale = (e.detectedLateBySeconds ?? 0) > maxAge;
    const seen = new Set<string>([e.userId]);
    for (const clanId of clanIds) {
      for (const m of clans.members(clanId)) {
        if (seen.has(m.userId)) continue; // one mirror per follower even across shared clans
        seen.add(m.userId);
        if (!m.policy.enabled) continue;
        const why = await this.cannotTrade(m.userId, e.venue);
        if (why) {
          // Tell the member why they weren't mirrored instead of silently skipping them.
          const skipped = mirrors.insertPending({ tradeId: trade.id, clanId, userId: m.userId, skipUntil });
          this.emit('mirror', mirrors.transition(skipped.id, 'pending', 'cancelled', { error: why })!);
          continue;
        }
        const mirror = mirrors.insertPending({ tradeId: trade.id, clanId, userId: m.userId, skipUntil });
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
  // Perpl: an enrolled key and account. Nad.fun: a signer the backend may use,
  // i.e. the backend's Privy signer attached to their wallet under their
  // current policy (or a registered test key). An injected venue (tests)
  // decides for itself.
  private async cannotTrade(userId: string, v: Venue): Promise<string | null> {
    const m = members.get(userId);
    if (!m) return 'unknown member';
    if (this.deps.venue) return null;
    if (v === 'perpl') return members.credentials(userId) && m.perplAccountId ? null : 'Perpl setup not finished';
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
  async leaderResized(trade: LeaderTrade, sizeRaw: bigint, entryPriceAusd: number | null, detectedLateBySeconds?: number) {
    const before = BigInt(trade.size);
    if (before <= 0n || sizeRaw === before) return;
    if (sizeRaw * 100n <= before) return this.closeTrade(trade);
    const ratio = Number((sizeRaw * 1_000_000n) / before) / 1_000_000;
    // No await from here to the end of the loop: the resize and the set of
    // open mirrors it applies to have to be read as one step.
    trades.resize(trade.id, sizeRaw.toString(), entryPriceAusd);
    this.emit('tradeChanged', trades.get(trade.id)!, ratio);
    for (const m of mirrors.forTrade(trade.id)) {
      if (m.status === 'open') this.queueAdjustment(trade, m, ratio, detectedLateBySeconds);
    }
  }

  private queueAdjustment(trade: LeaderTrade, m: Mirror, ratio: number, detectedLateBySeconds?: number) {
    const kind = ratio > 1 ? 'add' : 'reduce';
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

  // A member leaving a clan: nothing new fires for them there. Open mirrors
  // still follow partial exits and the exit, so nothing is left orphaned.
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
      const held = (await adapter.holdings(m.userId, [trade.market]))[0];
      if (!held) {
        this.emit('mirror', mirrors.transition(m.id, 'open', 'closed', { error: 'member had already exited this position' })!);
        return done('cancelled', { error: 'member had already exited' });
      }
      const size = BigInt(m.size);
      const keepMillionths = BigInt(Math.round(a.ratio * 1_000_000));

      if (a.kind === 'reduce') {
        let sell = size - (size * keepMillionths) / 1_000_000n;
        const heldRaw = BigInt(held.sizeRaw);
        if (sell > heldRaw) sell = heldRaw; // they sold some by hand; never sell what isn't theirs
        if (sell <= 0n) return done('done', { sizeDelta: '0', error: 'rounds to nothing at this size' });
        const fill = await adapter.close({ userId: m.userId, market: trade.market, sizeRaw: sell.toString(), onRef: onRef('mirror_reduce') });
        this.attempts.delete(id);
        this.applyReduce(a, m, BigInt(fill.sizeRaw || '0') || sell, { notionalUsd: fill.notionalAusd, oid: fill.orderId ?? null, tx: fill.txHash ?? null });
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
  private applyReduce(a: Adjustment, m: Mirror, sold: bigint, fill: { notionalUsd: number; oid: number | null; tx: string | null; error?: string | null }) {
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
      if (trade.closedAt) await this.guard(`reconcile exit ${m.id}`, () => this.reconcileExit(m.id));
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
      if (a.kind === 'reduce') this.applyReduce(a, m, BigInt(r.sizeRaw), note);
      else this.applyAdd(a, m, BigInt(r.sizeRaw), trade.venue === 'perpl' ? trade.leverage / 100 : 1, note);
      return;
    }
    if (r.state === 'filled') {
      this.emit('adjustment', adjustments.transition(id, 'submitting', 'done', { ...note, sizeDelta: r.sizeRaw })!);
      return;
    }
    // A partial sell that didn't happen still has to: it only takes risk off.
    // An add is only retried while the leader's move is fresh, like a new mirror.
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
    const r = await this.landed(trade.venue, 'mirror_close', m.id, m.userId);
    if (r.state === 'pending') return this.lookAgain(`x:${id}`, () => this.reconcileExit(id));
    if (r.state === 'filled') {
      this.emit('mirror', mirrors.transition(id, 'open', 'closed', { closeTx: r.txHash, closeOid: r.orderId, error: 'exit recovered after a restart' })!);
      return;
    }
    await this.closeMirror(m, trade);
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

  async closeTrade(trade: LeaderTrade) {
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
      } else if (m.status === 'open') {
        toClose.push(m);
      }
    }
    // Each follower is their own wallet/account, so unwind them in parallel:
    // the last follower shouldn't exit later just because of the clan's size.
    await Promise.all(toClose.map((m) => this.closeMirror(m, trade)));
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
      if (now?.status === 'open') await this.closeMirrorNow(now, trade); // an earlier adjustment may have sold it all
    });
  }

  private async closeMirrorNow(m: Mirror, trade: LeaderTrade) {
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
