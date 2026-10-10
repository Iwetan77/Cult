import { getDb } from '../store/db.js';
import { mirrors, trades } from './repo.js';
import type { Holding, TradeSide, Venue } from '../venues/types.js';

export interface Allocation {
  markerId: string; tradeId?: string; origin: 'leader' | 'auto_mirror' | 'manual_stack';
  size: bigint; entry: number | null; side: TradeSide; cultIds: string[];
}
export function allocationsFor(userId: string, h: Holding): Allocation[] {
  const out: Allocation[] = trades.openOnMarket(userId, h.venue, h.market).filter(t => t.side === h.side).map(t => ({
    markerId: 'trade:' + t.id, tradeId: t.id, origin: 'leader', size: BigInt(t.size), entry: t.entryPrice, side: t.side, cultIds: t.cultIds ?? [],
  }));
  for (const m of mirrors.forUser(userId, ['open'])) {
    const t = trades.get(m.tradeId);
    if (!t || t.venue !== h.venue || t.market !== h.market.toLowerCase() || t.side !== h.side || !m.size) continue;
    const units = h.size * Number(BigInt(m.size)) / Number(BigInt(h.sizeRaw));
    out.push({ markerId: 'mirror:' + m.id, tradeId: t.id, origin: 'auto_mirror', size: BigInt(m.size),
      entry: m.notionalUsd != null && units > 0 ? m.notionalUsd / units : h.entryPriceAusd, side: t.side, cultIds: [m.clanId] });
  }
  const stacks = getDb().prepare("SELECT * FROM stacks WHERE user_id = ? AND venue = ? AND market = ? AND side = ? AND status = 'open' ORDER BY created_at")
    .all(userId, h.venue, h.market.toLowerCase(), h.side) as { id: string; target_trade: string; size: string | null; notional_usd: number | null; clan_id: string }[];
  for (const s of stacks) {
    const size = BigInt(s.size ?? '0');
    const units = h.size * Number(size) / Number(BigInt(h.sizeRaw));
    out.push({ markerId: 'stack:' + s.id, tradeId: s.target_trade, origin: 'manual_stack', size,
      entry: s.notional_usd != null && units > 0 ? s.notional_usd / units : h.entryPriceAusd, side: h.side, cultIds: [s.clan_id] });
  }
  return out.filter(a => a.size > 0n);
}

export function sliceHolding(h: Holding, size: bigint, entry: number | null = h.entryPriceAusd): Holding {
  const raw = BigInt(h.sizeRaw);
  const part = size > raw ? raw : size;
  const share = raw > 0n ? Number(part) / Number(raw) : 0;
  const units = h.size * share;
  const pnl = entry == null ? null : (h.side === 'short' ? -1 : 1) * (h.markPriceAusd - entry) * units;
  return { ...h, sizeRaw: part.toString(), size: units, valueAusd: h.valueAusd * share, entryPriceAusd: entry, pnlAusd: pnl };
}

// Clamp all allocations together after an out-of-app reduction; never let
// each marker independently claim the whole remaining net position.
export function allocatedHoldings(userId: string, holdings: Holding[]): Holding[] {
  return holdings.flatMap(h => {
    const raw = BigInt(h.sizeRaw);
    if (raw <= 0n) return [];
    const parts = allocationsFor(userId, h);
    const total = parts.reduce((n, p) => n + p.size, 0n);
    let used = 0n;
    const out: Holding[] = parts.flatMap((p, i) => {
      const size = total > raw ? (i === parts.length - 1 ? raw - used : p.size * raw / total) : p.size;
      used += size;
      if (size <= 0n) return [];
      return [{ ...sliceHolding(h, size, p.entry), markerId: p.markerId, tradeId: p.tradeId,
        origin: p.cultIds.length ? p.origin : 'private' as const, cultIds: p.cultIds, isNetted: h.venue === 'perpl' }];
    });
    if (used < raw) {
      const units = h.size * Number(raw - used) / Number(raw);
      const costKnown = out.every(p => p.entryPriceAusd != null);
      const cost = out.reduce((n, p) => n + (p.entryPriceAusd ?? 0) * p.size, 0);
      const remainingEntry = units > 0 && costKnown && h.entryPriceAusd != null ? (h.entryPriceAusd * h.size - cost) / units : null;
      const entry = remainingEntry != null && Number.isFinite(remainingEntry) && remainingEntry > 0 ? remainingEntry : null;
      out.push({ ...sliceHolding(h, raw - used, entry), markerId: 'private:' + h.market,
        origin: 'private', cultIds: [], isNetted: h.venue === 'perpl' });
    }
    return out;
  });
}

export function allocationMarket(markerId: string, userId: string): { venue: Venue; market: string } | null {
  const [kind, id] = markerId.split(':', 2);
  if (kind === 'trade') {
    const t = trades.get(id!);
    return t && t.userId === userId && !t.closedAt ? { venue: t.venue, market: t.market } : null;
  }
  if (kind === 'mirror') {
    const m = mirrors.get(id!); const t = m && trades.get(m.tradeId);
    return m?.userId === userId && m.status === 'open' && t ? { venue: t.venue, market: t.market } : null;
  }
  if (kind === 'stack') {
    const s = getDb().prepare("SELECT venue, market FROM stacks WHERE id = ? AND user_id = ? AND status = 'open'").get(id!, userId) as { venue: Venue; market: string } | undefined;
    return s ?? null;
  }
  return null;
}
