import { randomUUID } from 'node:crypto';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { shortName } from './names.js';
import { clanBus } from './suggestions.js';

// Clan group chat: plain text between members, pushed live over the clan's
// SSE stream. A message can point at a chart marker ("selling half of this").

export interface ChatMessage {
  id: string;
  clanId: string;
  memberId: string;
  memberName: string;
  body: string;
  replyTo: string | null;
  markerId: string | null;
  createdAt: string; // ISO
}

export const MAX_MESSAGE_CHARS = 1000;
const PAGE_MAX = 100;
// Per member: at most BURST messages in WINDOW_MS, across all their clans.
const BURST = 8;
const WINDOW_MS = 10_000;
const recent = new Map<string, number[]>();

interface Row {
  id: string;
  clan_id: string;
  user_id: string;
  body: string;
  reply_to: string | null;
  marker_id: string | null;
  created_at: number;
}

const toApi = (r: Row): ChatMessage => ({
  id: r.id,
  clanId: r.clan_id,
  memberId: r.user_id,
  memberName: shortName(members.get(r.user_id)?.wallet ?? r.user_id),
  body: r.body,
  replyTo: r.reply_to,
  markerId: r.marker_id,
  createdAt: new Date(r.created_at).toISOString(),
});

export class ChatError extends Error {
  constructor(
    readonly status: 400 | 404 | 429,
    message: string,
  ) {
    super(message);
  }
}

export function postMessage(clanId: string, userId: string, input: { body: string; replyTo?: string | null; markerId?: string | null }): ChatMessage {
  const body = input.body.trim();
  if (!body) throw new ChatError(400, 'message is empty');
  if (body.length > MAX_MESSAGE_CHARS) throw new ChatError(400, `message is over ${MAX_MESSAGE_CHARS} characters`);
  if (input.replyTo && !getDb().prepare('SELECT 1 FROM clan_messages WHERE id = ? AND clan_id = ?').get(input.replyTo, clanId)) {
    throw new ChatError(404, 'the message you replied to is not in this clan');
  }
  const now = Date.now();
  const mine = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= BURST) throw new ChatError(429, 'slow down a little');
  mine.push(now);
  recent.set(userId, mine);

  const row: Row = { id: randomUUID(), clan_id: clanId, user_id: userId, body, reply_to: input.replyTo ?? null, marker_id: input.markerId ?? null, created_at: now };
  getDb()
    .prepare('INSERT INTO clan_messages (id, clan_id, user_id, body, reply_to, marker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.clan_id, row.user_id, row.body, row.reply_to, row.marker_id, row.created_at);
  const msg = toApi(row);
  clanBus.emit('message', clanId, msg);
  return msg;
}

// Newest page first by default; `before` (a message id) pages further back.
// Messages come back oldest to newest within the page, ready to render.
export function listMessages(clanId: string, opts: { before?: string; limit?: number } = {}): { messages: ChatMessage[]; hasMore: boolean } {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), PAGE_MAX);
  let cursor: number | null = null;
  if (opts.before) {
    const r = getDb().prepare('SELECT rowid AS seq FROM clan_messages WHERE id = ? AND clan_id = ?').get(opts.before, clanId) as { seq: number } | undefined;
    if (!r) throw new ChatError(404, 'no such message in this clan');
    cursor = r.seq;
  }
  const rows = getDb()
    .prepare(`SELECT * FROM clan_messages WHERE clan_id = ? ${cursor != null ? 'AND rowid < ?' : ''} ORDER BY rowid DESC LIMIT ?`)
    .all(...(cursor != null ? [clanId, cursor, limit + 1] : [clanId, limit + 1])) as unknown as Row[];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map(toApi), hasMore };
}
