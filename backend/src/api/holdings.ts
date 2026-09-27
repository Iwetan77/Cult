import { getDb } from '../store/db.js';
import type { Venue } from '../venues/types.js';

// Markets a member has touched through Cult on a venue (as leader, mirror or
// stack). Nad.fun has no per-wallet positions API, so this is the list we
// check balances for.
export function heldMarkets(userId: string, v: Venue): string[] {
  const rows = getDb()
    .prepare(
      `SELECT market FROM leader_trades WHERE user_id = ? AND venue = ?
       UNION SELECT t.market FROM mirrors m JOIN leader_trades t ON t.id = m.trade_id WHERE m.user_id = ? AND t.venue = ?
       UNION SELECT market FROM stacks WHERE user_id = ? AND venue = ?`,
    )
    .all(userId, v, userId, v, userId, v) as { market: string }[];
  return rows.map((r) => r.market);
}
