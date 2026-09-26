import { env } from '../config/env.js';
import { getContext, getMarket, getTicker, scale } from '../perpl/context.js';
import { PositionSide, type Market as PerplMarket, type Position } from '../perpl/types.js';
import { mirrors, trades, type LeaderTrade } from '../mirror/repo.js';
import { getDb } from '../store/db.js';
import { clans, type Clan } from '../store/clans.js';
import { members } from '../store/members.js';
import { restFor } from '../accounts/lifecycle.js';

// Shapes follow frontend/src/lib/contracts.ts (ChartSnapshot, ChartMarker, ...)
// so the frontend can consume this without adapting. Published in CONTRACTS.md.

export type MarkerOrigin = 'leader' | 'auto_mirror' | 'manual_stack';

export interface ChartMarker {
  id: string;
  tradeId: string; // leader trade this marker belongs to; stack target for manual_stack
  memberId: string;
  memberName: string;
  marketId: string;
  venue: 'perpl';
  origin: MarkerOrigin;
  side: 'long' | 'short';
  entryTime: number; // ms
  entryPrice: number | null; // null while a mirror is still pending
  markPrice: number;
  size: number | null;
  pnlUsd: number | null;
  valueUsd: number | null;
  leverage: number | null;
  isMine: boolean;
  mirrorStatus?: 'pending' | 'submitted' | 'filled';
  skipUntil?: string;
  txHash?: string | null;
}

export interface ApiMarket {
  venue: 'perpl';
  id: string;
  symbol: string;
  baseSymbol: string;
  quoteSymbol: string;
  maxLeverage: number;
  makerFeeBps: number;
  takerFeeBps: number;
}

export interface Candle {
  time: number; // seconds, lightweight-charts UTCTimestamp
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartMember {
  id: string;
  name: string;
  address: string;
  // Filled by the indexer (verified from chain). Backend never guesses these.
  winRate: null;
  realizedPnlUsd: null;
  tradeCount: number;
  verified: false;
}

export interface ChartSnapshot {
  clan: { id: string; name: string; inviteCode: string; memberCount: number; myPolicy: unknown };
  markets: ApiMarket[];
  selectedMarket: ApiMarket;
  candles: Candle[];
  markers: ChartMarker[];
  members: ChartMember[];
  asOf: string;
  autoMirrorOptOutWindowSeconds: number;
}

export const shortName = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

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

export async function candles(market: PerplMarket, resolutionSec = 300, count = 300): Promise<Candle[]> {
  const to = Date.now();
  const from = to - resolutionSec * 1000 * count;
  const res = await fetch(`${env.perplApiUrl}/v1/market-data/${market.id}/candles/${resolutionSec}/${from}-${to}`);
  if (!res.ok) throw new Error(`perpl candles ${res.status}`);
  const body = (await res.json()) as { d: { t: number; o: number; h: number; l: number; c: number }[] };
  return body.d.map((c) => ({
    time: Math.floor(c.t / 1000),
    open: scale.unprice(c.o, market),
    high: scale.unprice(c.h, market),
    low: scale.unprice(c.l, market),
    close: scale.unprice(c.c, market),
  }));
}

interface StackRow {
  id: string;
  user_id: string;
  target_trade: string;
  market_id: number;
  side: 'long' | 'short';
  size: number | null;
  leverage: number;
  open_tx: string | null;
  created_at: number;
}

export async function buildChart(clan: Clan, viewerId: string, marketId?: number, resolutionSec = 300): Promise<ChartSnapshot> {
  const ctx = await getContext();
  const openMarkets = ctx.markets.filter((m) => m.config.is_open);
  const selected = marketId ? await getMarket(marketId) : openMarkets[0]!;
  const roster = clans.members(clan.id);
  const userIds = roster.map((r) => r.userId);
  const { d: ticker } = await getTicker();
  const mark = scale.unprice(ticker[String(selected.id)]?.mrk ?? 0, selected);

  // Live position per member on the selected market, read from Perpl.
  const livePos = new Map<string, Position>();
  await Promise.all(
    userIds.map(async (uid) => {
      if (!members.credentials(uid)) return;
      try {
        const p = (await restFor(uid).positions()).d.find((x) => x.mkt === selected.id);
        if (p) livePos.set(uid, p);
      } catch {
        /* member without a Perpl account yet */
      }
    }),
  );

  const name = (uid: string) => shortName(members.get(uid)?.wallet ?? uid);
  const slice = (uid: string, sizeScaled: number | null) => {
    const p = livePos.get(uid);
    if (!p || sizeScaled == null) return { entryPrice: null, size: null, pnlUsd: null, valueUsd: null };
    const size = scale.unsize(Math.min(sizeScaled, p.s), selected);
    const entry = scale.unprice(p.ep, selected);
    const dir = p.sd === PositionSide.Long ? 1 : -1;
    return { entryPrice: entry, size, pnlUsd: dir * (mark - entry) * size, valueUsd: size * mark };
  };

  const markers: ChartMarker[] = [];
  const openTrades = trades.openForUsers(userIds).filter((t: LeaderTrade) => t.marketId === selected.id);
  for (const t of openTrades) {
    markers.push({
      id: `trade:${t.id}`,
      tradeId: t.id,
      memberId: t.userId,
      memberName: name(t.userId),
      marketId: String(t.marketId),
      venue: 'perpl',
      origin: 'leader',
      side: t.side,
      entryTime: t.openedAt,
      markPrice: mark,
      leverage: t.leverage / 100,
      isMine: t.userId === viewerId,
      txHash: t.openTx,
      ...slice(t.userId, t.size),
    });
    for (const m of mirrors.forTrade(t.id)) {
      if (m.clanId !== clan.id || !['pending', 'submitting', 'open'].includes(m.status)) continue;
      const pending = m.status === 'pending';
      markers.push({
        id: `mirror:${m.id}`,
        tradeId: t.id,
        memberId: m.userId,
        memberName: name(m.userId),
        marketId: String(t.marketId),
        venue: 'perpl',
        origin: 'auto_mirror',
        side: t.side,
        entryTime: m.createdAt,
        markPrice: mark,
        leverage: pending ? null : t.leverage / 100,
        isMine: m.userId === viewerId,
        mirrorStatus: pending ? 'pending' : m.status === 'submitting' ? 'submitted' : 'filled',
        ...(pending ? { skipUntil: new Date(m.skipUntil).toISOString() } : {}),
        txHash: m.openTx,
        ...(pending ? { entryPrice: null, size: null, pnlUsd: null, valueUsd: null } : slice(m.userId, m.size)),
      });
    }
  }

  const stackRows = getDb()
    .prepare(`SELECT * FROM stacks WHERE clan_id = ? AND market_id = ? AND status = 'open' ORDER BY created_at`)
    .all(clan.id, selected.id) as unknown as StackRow[];
  for (const s of stackRows) {
    if (!livePos.has(s.user_id)) continue; // closed outside the app
    markers.push({
      id: `stack:${s.id}`,
      tradeId: s.target_trade,
      memberId: s.user_id,
      memberName: name(s.user_id),
      marketId: String(s.market_id),
      venue: 'perpl',
      origin: 'manual_stack',
      side: s.side,
      entryTime: s.created_at,
      markPrice: mark,
      leverage: s.leverage / 100,
      isMine: s.user_id === viewerId,
      txHash: s.open_tx,
      ...slice(s.user_id, s.size),
    });
  }

  const me = clans.membership(clan.id, viewerId);
  return {
    clan: { id: clan.id, name: clan.name, inviteCode: clan.inviteCode, memberCount: roster.length, myPolicy: me?.policy ?? null },
    markets: openMarkets.map(toApiMarket),
    selectedMarket: toApiMarket(selected),
    candles: await candles(selected, resolutionSec),
    markers,
    members: roster.map((r) => {
      const m = members.get(r.userId);
      return {
        id: r.userId,
        name: name(r.userId),
        address: m?.wallet ?? '',
        winRate: null,
        realizedPnlUsd: null,
        tradeCount: 0,
        verified: false,
      };
    }),
    asOf: new Date().toISOString(),
    autoMirrorOptOutWindowSeconds: env.mirrorOptOutSeconds,
  };
}
