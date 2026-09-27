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
  size: string; // raw
  entryPrice: number | null; // AUSD per unit
  leverage: number; // hundredths
  marginFraction: number;
  openTx: string | null;
  openedAt: number;
  closedAt: number | null;
}

export type MirrorStatus = 'pending' | 'skipped' | 'submitting' | 'open' | 'closed' | 'failed' | 'cancelled';

export interface Mirror {
  id: string;
  tradeId: string;
  clanId: string;
  userId: string;
  status: MirrorStatus;
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
  size: 'size',
  entryPrice: 'entry_price',
  leverage: 'leverage',
  marginFraction: 'margin_fraction',
  openTx: 'open_tx',
  openedAt: 'opened_at',
  closedAt: 'closed_at',
};

const MIRROR_COLS: Record<keyof Mirror, string> = {
  id: 'id',
  tradeId: 'trade_id',
  clanId: 'clan_id',
  userId: 'user_id',
  status: 'status',
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

const tradeFrom = (r: unknown) => fromRow<LeaderTrade>(TRADE_COLS, r as Record<string, unknown>);
const mirrorFrom = (r: unknown) => fromRow<Mirror>(MIRROR_COLS, r as Record<string, unknown>);

export const trades = {
  insert(t: Omit<LeaderTrade, 'closedAt'>): LeaderTrade {
    t = { ...t, market: t.market.toLowerCase() };
    const keys = Object.keys(t) as (keyof LeaderTrade)[];
    getDb()
      .prepare(`INSERT INTO leader_trades (${keys.map((k) => TRADE_COLS[k]).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => t[k as keyof typeof t] as string | number | null));
    return this.get(t.id)!;
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
  markClosed(id: string) {
    getDb().prepare('UPDATE leader_trades SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(Date.now(), id);
  },
};

type MirrorPatch = Partial<Omit<Mirror, 'id' | 'tradeId' | 'clanId' | 'userId' | 'status' | 'createdAt' | 'updatedAt'>>;

export const mirrors = {
  insertPending(m: { tradeId: string; clanId: string; userId: string; skipUntil: number }): Mirror {
    const id = randomUUID();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO mirrors (id, trade_id, clan_id, user_id, status, skip_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, m.tradeId, m.clanId, m.userId, m.skipUntil, now, now);
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
      .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), Date.now(), id);
  },
  // Compare-and-set on status. Returns null if the mirror wasn't in `from`.
  transition(id: string, from: MirrorStatus, to: MirrorStatus, patch: MirrorPatch = {}): Mirror | null {
    const res = getDb().prepare('UPDATE mirrors SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, Date.now(), id, from);
    if (res.changes !== 1) return null;
    this.patch(id, patch);
    return this.get(id);
  },
};
