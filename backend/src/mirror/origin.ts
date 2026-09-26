import { getDb } from '../store/db.js';

export type EngineOrderKind = 'mirror_open' | 'mirror_close' | 'stack_open';

// Recorded synchronously before the order frame is sent (TradingSession onRq),
// so the position event for it can never beat the record.
export function recordEngineOrder(accountId: number, rq: number, kind: EngineOrderKind, refId: string) {
  getDb()
    .prepare('INSERT OR IGNORE INTO engine_orders (account_id, rq, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, rq, kind, refId, Date.now());
}

export function isEngineOrder(accountId: number, rq: number): boolean {
  return !!getDb().prepare('SELECT 1 FROM engine_orders WHERE account_id = ? AND rq = ?').get(accountId, rq);
}
