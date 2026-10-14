import { randomUUID } from 'node:crypto';
import { getDb } from '../store/db.js';
import type { OrderRef, TradeSide, Venue } from '../venues/types.js';

export interface MemberOrder {
  id: string; userId: string; venue: Venue; market: string; kind: 'open' | 'close';
  side: TradeSide; leverage: number; marginFraction: number; cultIds: string[];
  markerId: string | null; accountId: number | null; rq: number | null;
  txHash: string | null; bookedSize: string; state: string; createdAt: number;
  requestedNotional: number; beforeSize: string; targets: { markerId: string; size: string }[];
  bookedNotional: number; allocationId: string;
}
type Row = { id: string; user_id: string; venue: Venue; market: string; kind: 'open' | 'close';
  side: TradeSide; leverage: number; margin_fraction: number; cult_ids: string; marker_id: string | null;
  account_id: number | null; rq: number | null; tx_hash: string | null; booked_size: string; state: string; created_at: number;
  requested_notional: number; before_size: string; targets: string; booked_notional: number; allocation_id: string | null };
const from = (r: Row | undefined): MemberOrder | null => r ? ({
  id: r.id, userId: r.user_id, venue: r.venue, market: r.market, kind: r.kind, side: r.side,
  leverage: r.leverage, marginFraction: r.margin_fraction, cultIds: JSON.parse(r.cult_ids),
  markerId: r.marker_id, accountId: r.account_id, rq: r.rq, txHash: r.tx_hash,
  bookedSize: r.booked_size, state: r.state, createdAt: r.created_at,
  requestedNotional: r.requested_notional, beforeSize: r.before_size, targets: JSON.parse(r.targets),
  bookedNotional: r.booked_notional, allocationId: r.allocation_id ?? r.id,
}) : null;

// Audiences follow actual requests/transactions, not a mutable member+market slot.
export const memberOrders = {
  begin(o: Pick<MemberOrder, 'userId' | 'venue' | 'market' | 'kind' | 'side' | 'leverage' | 'marginFraction' | 'cultIds' | 'markerId' | 'requestedNotional'> &
    Partial<Pick<MemberOrder, 'beforeSize' | 'targets'>>): MemberOrder {
    const id = randomUUID();
    getDb().prepare('INSERT INTO member_orders (id, user_id, venue, market, kind, side, leverage, margin_fraction, cult_ids, marker_id, requested_notional, before_size, targets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, o.userId, o.venue, o.market.toLowerCase(), o.kind, o.side, o.leverage, o.marginFraction, JSON.stringify(o.cultIds),
        o.markerId, o.requestedNotional, o.beforeSize ?? '0', JSON.stringify(o.targets ?? []), Date.now());
    return this.get(id)!;
  },
  get(id: string) { return from(getDb().prepare('SELECT * FROM member_orders WHERE id = ?').get(id) as Row | undefined); },
  perpl(accountId: number, rq: number) {
    if (!Number.isFinite(accountId) || !Number.isFinite(rq)) return null;
    return from(getDb().prepare('SELECT * FROM member_orders WHERE account_id = ? AND rq = ?').get(accountId, rq) as Row | undefined);
  },
  tx(hash: string) {
    const key = hash.toLowerCase();
    return from(getDb().prepare(`SELECT * FROM member_orders WHERE tx_hash = ? OR id =
      (SELECT order_id FROM member_order_txs WHERE tx_hash = ?)` ).get(key, key) as Row | undefined);
  },
  ref(id: string, r: OrderRef) {
    // Approvals and post-sale swaps must not erase the trade's own hash.
    if (r.txHash) getDb().prepare('INSERT OR IGNORE INTO member_order_txs (tx_hash, order_id) VALUES (?, ?)')
      .run(r.txHash.toLowerCase(), id);
    getDb().prepare('UPDATE member_orders SET account_id = coalesce(?, account_id), rq = coalesce(?, rq), tx_hash = coalesce(?, tx_hash) WHERE id = ?')
      .run(r.accountId ?? null, r.rq ?? null, r.txHash?.toLowerCase() ?? null, id);
  },
  booked(id: string, size: string, notional?: number) {
    getDb().prepare("UPDATE member_orders SET booked_size = ?, booked_notional = coalesce(?, booked_notional), state = 'filled' WHERE id = ?").run(size, notional ?? null, id);
  },
  assignAllocation(id: string, allocationId: string) { getDb().prepare('UPDATE member_orders SET allocation_id = ? WHERE id = ?').run(allocationId, id); },
  applyTarget(id: string, markerId: string, total: bigint, reduce: (amount: bigint) => Promise<void>): Promise<void> {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const order = this.get(id)!;
      const targets = order.targets as (MemberOrder['targets'][number] & { applied?: string })[];
      const target = targets.find(t => t.markerId === markerId)!;
      const previous = BigInt(target.applied ?? '0');
      const effect = total > previous ? reduce(total - previous) : Promise.resolve();
      target.applied = (total > previous ? total : previous).toString();
      db.prepare('UPDATE member_orders SET targets = ? WHERE id = ?').run(JSON.stringify(targets), id);
      db.exec('COMMIT');
      return effect;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  commitFill(id: string, size: string, notional: number, mutate: () => Promise<void>): Promise<void> {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      // Engine mutations update SQLite before their first await; network
      // follow-ups run after this transaction commits.
      const effect = mutate();
      this.booked(id, size, notional);
      db.exec('COMMIT');
      return effect;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  failed(id: string) { getDb().prepare("UPDATE member_orders SET state = 'failed' WHERE id = ? AND booked_size = '0'").run(id); },
};
