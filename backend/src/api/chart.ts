import { env } from '../config/env.js';
import { getJson } from '../http.js';
import { NADFUN } from '../nadfun/constants.js';
import { getContext, getMarket, scale } from '../perpl/context.js';
import type { Market as PerplMarket } from '../perpl/types.js';
import { mirrors, trades, type LeaderTrade } from '../mirror/repo.js';
import { getDb } from '../store/db.js';
import { clans, type Clan } from '../store/clans.js';
import { members } from '../store/members.js';
import { venue, venueOf, type Holding, type TradeSide, type Venue } from '../venues/index.js';
import { perplTpSl } from '../venues/perpl.js';
import type { TpSl } from '../trading/tpsl.js';
import { shortName } from './names.js';
import { suggestionsFor, type TpSlSuggestion } from './suggestions.js';
import { statsFor, type MemberStats } from '../indexer/stats.js';

// Shapes follow frontend/src/lib/contracts.ts (ChartSnapshot, ChartMarker, ...)
// and are published in CONTRACTS.md. Every money figure is in dollars (settled
// in AUSD 1:1 under the hood; the UI shows $, never the word AUSD).

export type MarkerOrigin = 'leader' | 'auto_mirror' | 'manual_stack';

export interface ChartMarker {
  id: string; // "trade:<id>" | "mirror:<id>" | "stack:<id>"
  tradeId: string;
  memberId: string;
  memberName: string;
  marketId: string;
  venue: Venue;
  origin: MarkerOrigin;
  side: TradeSide;
  entryTime: number; // ms
  entryPrice: number | null; // AUSD per unit; null while a mirror is pending
  markPrice: number; // AUSD per unit
  size: number | null; // base units (perpl) / tokens (nadfun)
  pnlUsd: number | null; // AUSD
  valueUsd: number | null; // AUSD (perpl: notional at mark; nadfun: what selling returns now)
  leverage: number | null;
  isMine: boolean;
  mirrorStatus?: 'pending' | 'submitted' | 'filled';
  skipUntil?: string;
  txHash?: string | null;
  // Perpl only: the owner's live TP/SL (Perpl trigger orders on that position).
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
  // Perpl only: clan-mates' latest TP/SL suggestions on this marker.
  suggestions?: TpSlSuggestion[];
}

export interface ApiMarket {
  venue: Venue;
  id: string; // perpl market id | nadfun token address
  symbol: string;
  baseSymbol: string;
  quoteSymbol: 'USD';
  maxLeverage: number;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  tokenAddress?: string;
  imageUri?: string;
}

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartSnapshot {
  clan: { id: string; name: string; inviteCode: string; memberCount: number; myPolicy: unknown };
  markets: ApiMarket[];
  selectedMarket: ApiMarket;
  candles: Candle[];
  markers: ChartMarker[];
  // Track record from the indexer (verified on-chain history). Unverified =
  // the indexer hasn't seen this wallet or isn't reachable: nulls, not zeros.
  members: ({ id: string; name: string; address: string; winRate: number | null; realizedPnlUsd: number | null; tradeCount: number; verified: boolean } & {
    stats: MemberStats;
  })[];
  asOf: string;
  autoMirrorOptOutWindowSeconds: number;
}

export { shortName };

export function toApiMarket(m: PerplMarket): ApiMarket {
  return {
    venue: 'perpl',
    id: String(m.id),
    symbol: `${m.symbol}-PERP`,
    baseSymbol: m.symbol,
    quoteSymbol: 'USD',
    maxLeverage: Math.floor((10_000 / m.config.initial_margin) * 100) / 100,
    makerFeeBps: m.config.maker_fee / 100,
    takerFeeBps: m.config.taker_fee / 100,
  };
}

const nadMeta = new Map<string, { symbol: string; imageUri?: string }>();
export async function nadMarket(token: string): Promise<ApiMarket> {
  const t = token.toLowerCase();
  if (!nadMeta.has(t)) {
    const r = await getJson(`${NADFUN.apiUrl}/token/${token}`, { retries: 1 }).catch(() => null);
    const info = (r as { token_info?: { symbol: string; image_uri?: string } } | null)?.token_info;
    nadMeta.set(t, { symbol: info?.symbol ?? 'TOKEN', imageUri: info?.image_uri });
  }
  const meta = nadMeta.get(t)!;
  return { venue: 'nadfun', id: t, symbol: meta.symbol, baseSymbol: meta.symbol, quoteSymbol: 'USD', maxLeverage: 1, makerFeeBps: null, takerFeeBps: null, tokenAddress: t, imageUri: meta.imageUri };
}

export async function perplCandles(market: PerplMarket, resolutionSec = 300, count = 300): Promise<Candle[]> {
  const to = Date.now();
  const from = to - resolutionSec * 1000 * count;
  const body = await getJson<{ d: { t: number; o: number; h: number; l: number; c: number }[] }>(
    `${env.perplApiUrl}/v1/market-data/${market.id}/candles/${resolutionSec}/${from}-${to}`,
  );
  return body.d.map((c) => ({
    time: Math.floor(c.t / 1000),
    open: scale.unprice(c.o, market),
    high: scale.unprice(c.h, market),
    low: scale.unprice(c.l, market),
    close: scale.unprice(c.c, market),
  }));
}

const NAD_RES: Record<number, string> = { 60: '1', 300: '5', 900: '15', 1800: '30', 3600: '60', 14400: '240', 86400: '1D' };

// Nad.fun's chart API priced in USD directly (chart_type=price_usd), shown as AUSD.
export async function nadCandles(token: string, resolutionSec = 300, count = 300): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const res = NAD_RES[resolutionSec] ?? '5';
  const url = `${NADFUN.apiUrl}/trade/chart/${token}?resolution=${res}&from=${to - resolutionSec * count}&to=${to}&countback=${count}&chart_type=price_usd`;
  const b = await getJson<{ t: number[]; o: string[]; h: string[]; l: string[]; c: string[] }>(url);
  return (b.t ?? []).map((t, i) => ({ time: t, open: Number(b.o[i]), high: Number(b.h[i]), low: Number(b.l[i]), close: Number(b.c[i]) }));
}

// One marker's share of a member's live holding on a market. A member can hold
// their own trade, a mirror and a stack on the same market, which the venue
// reports as one position; `sizeRaw` (same raw unit as the holding) says how
// much of it this marker accounts for.
export function sliceOf(v: Venue, h: Holding | undefined, sizeRaw: string | null, entryPrice: number | null) {
  const none = { entryPrice, size: null, pnlUsd: null, valueUsd: null };
  if (!h || sizeRaw == null) return none;
  const held = BigInt(h.sizeRaw);
  if (held === 0n) return none;
  const part = BigInt(sizeRaw);
  // share in millionths, integer math on the raw sizes, capped at the whole holding
  const share = Number(((part < held ? part : held) * 1_000_000n) / held) / 1_000_000;
  const size = h.size * share;
  const valueUsd = h.valueAusd * share;
  const entry = entryPrice ?? h.entryPriceAusd;
  const pnlUsd = v === 'perpl' ? (h.pnlAusd ?? 0) * share : entry != null ? valueUsd - entry * size : null;
  return { entryPrice: entry, size, pnlUsd, valueUsd };
}

interface StackRow {
  id: string;
  user_id: string;
  target_trade: string;
  market: string;
  side: TradeSide;
  size: string | null;
  notional_usd: number | null;
  leverage: number;
  open_tx: string | null;
  created_at: number;
}

export async function buildChart(clan: Clan, viewerId: string, marketId?: string, resolutionSec = 300): Promise<ChartSnapshot> {
  const ctx = await getContext();
  const roster = clans.members(clan.id);
  const userIds = roster.map((r) => r.userId);
  const openTrades = trades.openForUsers(userIds);

  // Market list: every open Perpl market, plus any Nad.fun token the clan is in right now.
  const perplMarkets = ctx.markets.filter((m) => m.config.is_open).map(toApiMarket);
  const nadTokens = [...new Set(openTrades.filter((t) => t.venue === 'nadfun').map((t) => t.market))];
  const nadMarkets = await Promise.all(nadTokens.map(nadMarket));
  const markets = [...perplMarkets, ...nadMarkets];

  const v: Venue = marketId ? venueOf(marketId) : 'perpl';
  const selected: ApiMarket =
    v === 'nadfun' ? await nadMarket(marketId!) : marketId ? toApiMarket(await getMarket(Number(marketId))) : perplMarkets[0]!;
  const adapter = venue(v);
  const mark = await adapter.markPriceAusd(selected.id).catch(() => 0);

  const here = openTrades.filter((t) => t.venue === v && t.market === selected.id.toLowerCase());
  const stackRows = getDb()
    .prepare(`SELECT * FROM stacks WHERE clan_id = ? AND venue = ? AND market = ? AND status = 'open' ORDER BY created_at`)
    .all(clan.id, v, selected.id.toLowerCase()) as unknown as StackRow[];

  // Live holding per involved member on this market, read from the venue.
  const involved = new Set<string>([...here.map((t) => t.userId), ...stackRows.map((s) => s.user_id)]);
  for (const t of here) for (const m of mirrors.forTrade(t.id)) involved.add(m.userId);
  const live = new Map<string, Holding>();
  await Promise.all(
    [...involved].map(async (uid) => {
      const h = await adapter.holdings(uid, [selected.id]).catch(() => []);
      if (h[0]) live.set(uid, h[0]);
    }),
  );

  // Perpl: each involved member's real TP/SL, read from their Perpl open orders.
  const tpsl = new Map<string, TpSl>();
  if (v === 'perpl') {
    await Promise.all(
      [...involved].map(async (uid) => {
        const t = await perplTpSl(uid, Number(selected.id)).catch(() => null);
        if (t) tpsl.set(uid, t);
      }),
    );
  }

  const name = (uid: string) => shortName(members.get(uid)?.wallet ?? uid);
  // Value one member's slice of their holding. `sizeRaw` is how much of it this
  // marker accounts for; `costAusd` is what that slice cost, when we know it.
  const slice = (uid: string, sizeRaw: string | null, entryPrice: number | null) => sliceOf(v, live.get(uid), sizeRaw, entryPrice);

  const markers: ChartMarker[] = [];
  for (const t of here) {
    markers.push({
      id: `trade:${t.id}`,
      tradeId: t.id,
      memberId: t.userId,
      memberName: name(t.userId),
      marketId: t.market,
      venue: v,
      origin: 'leader',
      side: t.side,
      entryTime: t.openedAt,
      markPrice: mark,
      leverage: t.leverage / 100,
      isMine: t.userId === viewerId,
      txHash: t.openTx,
      ...slice(t.userId, t.size, t.entryPrice),
    });
    for (const m of mirrors.forTrade(t.id)) {
      if (m.clanId !== clan.id || !['pending', 'submitting', 'open'].includes(m.status)) continue;
      const pending = m.status === 'pending';
      // Nad.fun mirror entry = dollars spent / tokens got. Perpl uses the position's own entry.
      const mEntry = v === 'nadfun' && m.notionalUsd && m.size && m.size !== '0' ? m.notionalUsd / (Number(m.size) / 1e18) : null;
      markers.push({
        id: `mirror:${m.id}`,
        tradeId: t.id,
        memberId: m.userId,
        memberName: name(m.userId),
        marketId: t.market,
        venue: v,
        origin: 'auto_mirror',
        side: t.side,
        entryTime: m.createdAt,
        markPrice: mark,
        leverage: pending ? null : t.leverage / 100,
        isMine: m.userId === viewerId,
        mirrorStatus: pending ? 'pending' : m.status === 'submitting' ? 'submitted' : 'filled',
        ...(pending ? { skipUntil: new Date(m.skipUntil).toISOString() } : {}),
        txHash: m.openTx,
        ...(pending || m.status === 'submitting'
          ? { entryPrice: null, size: null, pnlUsd: null, valueUsd: null }
          : slice(m.userId, m.size, v === 'nadfun' ? mEntry : null)),
      });
    }
  }
  for (const s of stackRows) {
    if (!live.has(s.user_id)) continue; // exited outside the app
    const entry = v === 'nadfun' && s.size && s.notional_usd ? s.notional_usd / (Number(s.size) / 1e18) : null;
    markers.push({
      id: `stack:${s.id}`,
      tradeId: s.target_trade,
      memberId: s.user_id,
      memberName: name(s.user_id),
      marketId: s.market,
      venue: v,
      origin: 'manual_stack',
      side: s.side,
      entryTime: s.created_at,
      markPrice: mark,
      leverage: s.leverage / 100,
      isMine: s.user_id === viewerId,
      txHash: s.open_tx,
      ...slice(s.user_id, s.size, entry),
    });
  }

  if (v === 'perpl') {
    const sugg = suggestionsFor(clan.id, markers.map((m) => m.id));
    for (const m of markers) {
      const t = tpsl.get(m.memberId);
      m.takeProfitPrice = t?.takeProfit ?? null;
      m.stopLossPrice = t?.stopLoss ?? null;
      m.suggestions = sugg.get(m.id) ?? [];
    }
  }

  const stats = await statsFor(roster.map((r) => members.get(r.userId)?.wallet ?? '').filter(Boolean));
  const me = clans.membership(clan.id, viewerId);
  return {
    clan: { id: clan.id, name: clan.name, inviteCode: clan.inviteCode, memberCount: roster.length, myPolicy: me?.policy ?? null },
    markets,
    selectedMarket: selected,
    candles: await (v === 'nadfun' ? nadCandles(selected.id, resolutionSec) : perplCandles(await getMarket(Number(selected.id)), resolutionSec)).catch(() => []),
    markers,
    members: roster.map((r) => {
      const address = members.get(r.userId)?.wallet ?? '';
      const st = stats.get(address.toLowerCase())!;
      return {
        id: r.userId,
        name: name(r.userId),
        address,
        winRate: st.winRate,
        realizedPnlUsd: st.realizedPnlUsd,
        tradeCount: st.tradeCount,
        verified: st.verified,
        stats: st,
      };
    }),
    asOf: new Date().toISOString(),
    autoMirrorOptOutWindowSeconds: env.mirrorOptOutSeconds,
  };
}

export type { LeaderTrade };
