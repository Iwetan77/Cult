import { randomUUID } from 'node:crypto';
import { getDb } from '../store/db.js';
import type { TradeSide, Venue } from '../venues/types.js';

export interface LeaderTrade {
  id: string;
  venue: Venue;
  userId: string;
  accountId: number | null; // perpl
  market: string; // perpl market id | nadfun token (lowercase)
  side: TradeSide;
  positionId: number | null; // perpl
  netPositionId?: number | null; // multiple app fills can share a net Perpl position
  size: string; // raw, the leader's size now
  openSize: string | null; // raw, what they opened with (null on rows from before v3)
  entryPrice: number | null; // AUSD per unit
  leverage: number; // hundredths
  marginFraction: number;
  openTx: string | null;
  openedAt: number;
  closedAt: number | null;
  cultIds: string[] | null; // the cults it was posted to; null = every cult the member is in
}

export type AdjustmentKind = 'add' | 'reduce';
export type AdjustmentStatus = 'pending' | 'skipped' | 'submitting' | 'done' | 'failed' | 'cancelled';

// A mirror following its leader's add or partial exit.
export interface Adjustment {
  id: string;
  mirrorId: string;
  tradeId: string;
  clanId: string;
  userId: string;
  kind: AdjustmentKind;
  ratio: number; // leader's size after / before
  status: AdjustmentStatus;
  skipUntil: number;
  sizeDelta: string | null;
  beforeSize?: string | null;
  availableSize?: string | null;
  notionalUsd: number | null;
  rq: number | null;
  oid: number | null;
  tx: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MirrorStatus = 'pending' | 'skipped' | 'submitting' | 'open' | 'closed' | 'failed' | 'cancelled';

export interface Mirror {
  id: string;
  tradeId: string;
  clanId: string;
  userId: string;
  status: MirrorStatus;
  followExits?: boolean;
  skipUntil: number;
  marginUsd: number | null;
  notionalUsd: number | null;
  size: string | null;
  capApplied: string | null;
  openRq: number | null;
  openOid: number | null;
  openTx: string | null;
  closeRq: number | null;
  closeOid: number | null;
  closeTx: string | null;
  closeRef?: string | null;
  closeBeforeSize?: string | null;
  closeRequestedSize?: string | null;
  closeBookedSize?: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const TRADE_COLS: Record<keyof LeaderTrade, string> = {
  id: 'id',
  venue: 'venue',
  userId: 'user_id',
  accountId: 'account_id',
  market: 'market',
  side: 'side',
  positionId: 'position_id',
  netPositionId: 'net_position_id',
  size: 'size',
  openSize: 'open_size',
  entryPrice: 'entry_price',
  leverage: 'leverage',
  marginFraction: 'margin_fraction',
  openTx: 'open_tx',
  openedAt: 'opened_at',
  closedAt: 'closed_at',
  cultIds: 'cult_ids',
};

const MIRROR_COLS: Record<keyof Mirror, string> = {
  id: 'id',
  tradeId: 'trade_id',
  clanId: 'clan_id',
  userId: 'user_id',
  status: 'status',
  followExits: 'follow_exits',
  skipUntil: 'skip_until',
  marginUsd: 'margin_usd',
  notionalUsd: 'notional_usd',
  size: 'size',
  capApplied: 'cap_applied',
  openRq: 'open_rq',
  openOid: 'open_oid',
  openTx: 'open_tx',
  closeRq: 'close_rq',
  closeOid: 'close_oid',
  closeTx: 'close_tx',
  closeRef: 'close_ref',
  closeBeforeSize: 'close_before_size',
  closeRequestedSize: 'close_requested_size',
  closeBookedSize: 'close_booked_size',
  error: 'error',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const ADJ_COLS: Record<keyof Adjustment, string> = {
  id: 'id',
  mirrorId: 'mirror_id',
  tradeId: 'trade_id',
  clanId: 'clan_id',
  userId: 'user_id',
  kind: 'kind',
  ratio: 'ratio',
  status: 'status',
  skipUntil: 'skip_until',
  sizeDelta: 'size_delta',
  beforeSize: 'before_size',
  availableSize: 'available_size',
  notionalUsd: 'notional_usd',
  rq: 'rq',
  oid: 'oid',
  tx: 'tx',
  error: 'error',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

function fromRow<T>(cols: Record<string, string>, row: Record<string, unknown> | undefined): T | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(cols)) out[k] = row[c] ?? null;
  return out as T;
}

const tradeFrom = (r: unknown) => {
  const t = fromRow<LeaderTrade>(TRADE_COLS, r as Record<string, unknown>);
  if (t) t.cultIds = t.cultIds ? (JSON.parse(t.cultIds as unknown as string) as string[]) : null;
  return t;
};
const mirrorFrom = (r: unknown) => {
  const m = fromRow<Mirror>(MIRROR_COLS, r as Record<string, unknown>);
  if (m) m.followExits = (r as Record<string, unknown>).follow_exits !== 0;
  return m;
};
const adjFrom = (r: unknown) => fromRow<Adjustment>(ADJ_COLS, r as Record<string, unknown>);

export const trades = {
  insert(t: Omit<LeaderTrade, 'closedAt' | 'openSize' | 'cultIds'> & { cultIds?: string[] | null }): LeaderTrade {
    const row: Omit<LeaderTrade, 'closedAt'> = { ...t, market: t.market.toLowerCase(), openSize: t.size, cultIds: t.cultIds ?? null };
    const keys = Object.keys(row) as (keyof typeof row)[];
    const value = (k: keyof typeof row) => (k === 'cultIds' ? (row.cultIds ? JSON.stringify(row.cultIds) : null) : (row[k] as string | number | null));
    getDb()
      .prepare(`INSERT INTO leader_trades (${keys.map((k) => TRADE_COLS[k]).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map(value));
    return this.get(row.id)!;
  },
  get(id: string) {
    return tradeFrom(getDb().prepare('SELECT * FROM leader_trades WHERE id = ?').get(id));
  },
  byPosition(accountId: number, positionId: number) {
    return tradeFrom(getDb().prepare('SELECT * FROM leader_trades WHERE account_id = ? AND position_id = ?').get(accountId, positionId));
  },
  openFor(userId: string, venue: Venue, market: string) {
    return tradeFrom(
      getDb()
        .prepare('SELECT * FROM leader_trades WHERE user_id = ? AND venue = ? AND market = ? AND closed_at IS NULL ORDER BY opened_at DESC')
        .get(userId, venue, market.toLowerCase()),
    );
  },
  openForUsers(userIds: string[]): LeaderTrade[] {
    if (userIds.length === 0) return [];
    return getDb()
      .prepare(`SELECT * FROM leader_trades WHERE closed_at IS NULL AND user_id IN (${userIds.map(() => '?').join(',')}) ORDER BY opened_at`)
      .all(...userIds)
      .map((r) => tradeFrom(r)!);
  },
  openOnMarket(userId: string, venue: Venue, market: string): LeaderTrade[] {
    return getDb().prepare('SELECT * FROM leader_trades WHERE user_id = ? AND venue = ? AND market = ? AND closed_at IS NULL ORDER BY opened_at, id')
      .all(userId, venue, market.toLowerCase()).map(r => tradeFrom(r)!);
  },
  attachPosition(userId: string, market: string, positionId: number) {
    getDb().prepare("UPDATE leader_trades SET net_position_id = ? WHERE user_id = ? AND venue = 'perpl' AND market = ? AND closed_at IS NULL AND position_id IS NULL")
      .run(positionId, userId, market.toLowerCase());
  },
  markClosed(id: string) {
    getDb().prepare('UPDATE leader_trades SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(Date.now(), id);
  },
  // The leader added or partly exited: their size now, and their new average entry.
  resize(id: string, size: string, entryPrice: number | null) {
    getDb().prepare('UPDATE leader_trades SET size = ?, entry_price = ? WHERE id = ?').run(size, entryPrice, id);
  },
};

// How big the leader's trade is now against what they opened with. A mirror
// sized after a change (still in its skip window when it happened) is sized
// by this too, so it lands where the leader is now, not where they started.
export function sizeFactor(t: LeaderTrade): number {
  if (!t.openSize || t.openSize === '0') return 1;
  return Number((BigInt(t.size) * 1_000_000n) / BigInt(t.openSize)) / 1_000_000;
}

type MirrorPatch = Partial<Omit<Mirror, 'id' | 'tradeId' | 'clanId' | 'userId' | 'status' | 'createdAt' | 'updatedAt'>>;

export const mirrors = {
  insertPending(m: { tradeId: string; clanId: string; userId: string; skipUntil: number; followExits?: boolean }): Mirror {
    const id = randomUUID();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO mirrors (id, trade_id, clan_id, user_id, status, skip_until, created_at, updated_at, follow_exits)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(id, m.tradeId, m.clanId, m.userId, m.skipUntil, now, now, m.followExits === false ? 0 : 1);
    return this.get(id)!;
  },
  get(id: string) {
    return mirrorFrom(getDb().prepare('SELECT * FROM mirrors WHERE id = ?').get(id));
  },
  forTrade(tradeId: string): Mirror[] {
    return getDb().prepare('SELECT * FROM mirrors WHERE trade_id = ? ORDER BY created_at').all(tradeId).map((r) => mirrorFrom(r)!);
  },
  byStatus(status: MirrorStatus): Mirror[] {
    return getDb().prepare('SELECT * FROM mirrors WHERE status = ?').all(status).map((r) => mirrorFrom(r)!);
  },
  forUser(userId: string, statuses: MirrorStatus[]): Mirror[] {
    return getDb()
      .prepare(`SELECT * FROM mirrors WHERE user_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(userId, ...statuses)
      .map((r) => mirrorFrom(r)!);
  },
  forClan(clanId: string, statuses: MirrorStatus[]): Mirror[] {
    return getDb()
      .prepare(`SELECT * FROM mirrors WHERE clan_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(clanId, ...statuses)
      .map((r) => mirrorFrom(r)!);
  },
  patch(id: string, patch: MirrorPatch) {
    const keys = Object.keys(patch) as (keyof MirrorPatch)[];
    if (keys.length === 0) return;
    getDb()
      .prepare(`UPDATE mirrors SET ${keys.map((k) => `${MIRROR_COLS[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => typeof patch[k] === 'boolean' ? Number(patch[k]) : (patch[k] ?? null) as string | number | null), Date.now(), id);
  },
  // Compare-and-set on status. Returns null if the mirror wasn't in `from`.
  transition(id: string, from: MirrorStatus, to: MirrorStatus, patch: MirrorPatch = {}): Mirror | null {
    const res = getDb().prepare('UPDATE mirrors SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, Date.now(), id, from);
    if (res.changes !== 1) return null;
    this.patch(id, patch);
    return this.get(id);
  },
};

type AdjustmentPatch = Partial<Pick<Adjustment, 'skipUntil' | 'sizeDelta' | 'beforeSize' | 'availableSize' | 'notionalUsd' | 'rq' | 'oid' | 'tx' | 'error'>>;

export const adjustments = {
  insert(a: Pick<Adjustment, 'mirrorId' | 'tradeId' | 'clanId' | 'userId' | 'kind' | 'ratio' | 'skipUntil'>): Adjustment {
    const id = randomUUID();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO mirror_adjustments (id, mirror_id, trade_id, clan_id, user_id, kind, ratio, status, skip_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, a.mirrorId, a.tradeId, a.clanId, a.userId, a.kind, a.ratio, a.skipUntil, now, now);
    return this.get(id)!;
  },
  get(id: string) {
    return adjFrom(getDb().prepare('SELECT * FROM mirror_adjustments WHERE id = ?').get(id));
  },
  forMirror(mirrorId: string): Adjustment[] {
    return getDb().prepare('SELECT * FROM mirror_adjustments WHERE mirror_id = ? ORDER BY created_at').all(mirrorId).map((r) => adjFrom(r)!);
  },
  forTrade(tradeId: string, statuses: AdjustmentStatus[]): Adjustment[] {
    return getDb()
      .prepare(`SELECT * FROM mirror_adjustments WHERE trade_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(tradeId, ...statuses)
      .map((r) => adjFrom(r)!);
  },
  byStatus(status: AdjustmentStatus): Adjustment[] {
    return getDb().prepare('SELECT * FROM mirror_adjustments WHERE status = ? ORDER BY created_at').all(status).map((r) => adjFrom(r)!);
  },
  patch(id: string, patch: AdjustmentPatch) {
    const keys = Object.keys(patch) as (keyof AdjustmentPatch)[];
    if (keys.length === 0) return;
    getDb()
      .prepare(`UPDATE mirror_adjustments SET ${keys.map((k) => `${ADJ_COLS[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), Date.now(), id);
  },
  transition(id: string, from: AdjustmentStatus, to: AdjustmentStatus, patch: AdjustmentPatch = {}): Adjustment | null {
    const res = getDb().prepare('UPDATE mirror_adjustments SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, Date.now(), id, from);
    if (res.changes !== 1) return null;
    this.patch(id, patch);
    return this.get(id);
  },
};

// Which of the trader's cults a trade reaches: the ones it was posted to that
// they're still in, or all of them.
export function tradeCults(t: Pick<LeaderTrade, 'cultIds'>, memberCults: string[]): string[] {
  return t.cultIds ? memberCults.filter((id) => t.cultIds!.includes(id)) : memberCults;
}
