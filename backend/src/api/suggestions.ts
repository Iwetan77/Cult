import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import type { ChatMessage } from './chat.js';
import { shortName } from './names.js';

export interface TpSlSuggestion {
  id: string;
  markerId: string;
  tradeId: string;
  fromMemberId: string;
  fromName: string;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  createdAt: string;
}

// Clan-level events that aren't engine events (SSE fans these out too).
export const clanBus = new EventEmitter<{ suggestion: [string, TpSlSuggestion]; message: [string, ChatMessage] }>();

interface Row {
  id: string;
  clan_id: string;
  trade_id: string;
  marker_id: string;
  from_user: string;
  take_profit: number | null;
  stop_loss: number | null;
  created_at: number;
}

const toApi = (r: Row): TpSlSuggestion => ({
  id: r.id,
  markerId: r.marker_id,
  tradeId: r.trade_id,
  fromMemberId: r.from_user,
  fromName: shortName(members.get(r.from_user)?.wallet ?? r.from_user),
  takeProfitPrice: r.take_profit,
  stopLossPrice: r.stop_loss,
  createdAt: new Date(r.created_at).toISOString(),
});

export function addSuggestion(clanId: string, tradeId: string, markerId: string, fromUser: string, tp: number | null, sl: number | null) {
  const row: Row = { id: randomUUID(), clan_id: clanId, trade_id: tradeId, marker_id: markerId, from_user: fromUser, take_profit: tp, stop_loss: sl, created_at: Date.now() };
  getDb()
    .prepare('INSERT INTO tpsl_suggestions (id, clan_id, trade_id, marker_id, from_user, take_profit, stop_loss, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.clan_id, row.trade_id, row.marker_id, row.from_user, row.take_profit, row.stop_loss, row.created_at);
  const s = toApi(row);
  clanBus.emit('suggestion', clanId, s);
  return s;
}

// Latest suggestion per suggester for each marker (older ones are superseded).
export function suggestionsFor(clanId: string, markerIds: string[]): Map<string, TpSlSuggestion[]> {
  const out = new Map<string, TpSlSuggestion[]>();
  if (markerIds.length === 0) return out;
  const rows = getDb()
    .prepare(
      `SELECT * FROM tpsl_suggestions s WHERE clan_id = ? AND marker_id IN (${markerIds.map(() => '?').join(',')})
       AND created_at = (SELECT MAX(created_at) FROM tpsl_suggestions x WHERE x.marker_id = s.marker_id AND x.from_user = s.from_user)
       ORDER BY created_at DESC`,
    )
    .all(clanId, ...markerIds) as unknown as Row[];
  for (const r of rows) {
    const list = out.get(r.marker_id) ?? [];
    list.push(toApi(r));
    out.set(r.marker_id, list);
  }
  return out;
}
