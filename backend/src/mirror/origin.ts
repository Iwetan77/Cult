import { getDb } from '../store/db.js';

export type EngineOrderKind = 'mirror_open' | 'mirror_close' | 'stack_open' | 'stack_close';

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

export function recordEngineTx(txHash: string, wallet: string, kind: EngineOrderKind, refId: string) {
  getDb()
    .prepare('INSERT OR IGNORE INTO engine_txs (tx_hash, wallet, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(txHash.toLowerCase(), wallet.toLowerCase(), kind, refId, Date.now());
}

export function isEngineTx(txHash: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM engine_txs WHERE tx_hash = ?').get(txHash.toLowerCase());
}

// One entry point for whatever ref a venue hands back before an order leaves.
export function recordRef(ref: { rq?: number; accountId?: number; txHash?: string; wallet?: string }, kind: EngineOrderKind, refId: string) {
  if (ref.rq != null && ref.accountId != null) recordEngineOrder(ref.accountId, ref.rq, kind, refId);
  if (ref.txHash) recordEngineTx(ref.txHash, ref.wallet ?? '', kind, refId);
}
