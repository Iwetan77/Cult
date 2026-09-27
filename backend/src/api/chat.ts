import { randomUUID } from 'node:crypto';
import { clans } from '../store/clans.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { countryName } from './countries.js';
import { shortName } from './names.js';
import { clanBus } from './suggestions.js';

// Chat rooms, pushed live over SSE:
//   "global"        everyone on Cult
//   "country:NG"    members who picked that country
//   "cult:<id>"     that cult's members (its group chat)
// Plain text. A message can point at a chart marker ("selling half of this").

export interface ChatMessage {
  id: string;
  room: string;
  clanId: string | null; // set for cult rooms (kept for the cult chat's existing clients)
  memberId: string;
  memberName: string;
  body: string;
  replyTo: string | null;
  markerId: string | null;
  createdAt: string; // ISO
}

export const MAX_MESSAGE_CHARS = 1000;
const PAGE_MAX = 100;
// Per member: at most BURST messages in WINDOW_MS, across all rooms.
const BURST = 8;
const WINDOW_MS = 10_000;
const recent = new Map<string, number[]>();

interface Row {
  id: string;
  room: string;
  user_id: string;
  body: string;
  reply_to: string | null;
  marker_id: string | null;
  created_at: number;
}

const toApi = (r: Row): ChatMessage => ({
  id: r.id,
  room: r.room,
  clanId: r.room.startsWith('cult:') ? r.room.slice(5) : null,
  memberId: r.user_id,
  memberName: shortName(members.get(r.user_id)?.wallet ?? r.user_id),
  body: r.body,
  replyTo: r.reply_to,
  markerId: r.marker_id,
  createdAt: new Date(r.created_at).toISOString(),
});

export class ChatError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 429,
    message: string,
  ) {
    super(message);
  }
}

export const cultRoom = (clanId: string) => `cult:${clanId}`;

// Can this member read and post in this room? Returns the room's display name.
export function openRoom(room: string, userId: string): { room: string; name: string } {
  if (room === 'global') return { room, name: 'Global' };
  if (room.startsWith('country:')) {
    const code = room.slice(8).toUpperCase();
    const name = countryName(code);
    if (!name) throw new ChatError(404, 'no such room');
    if (members.get(userId)?.country !== code) throw new ChatError(403, `that's the ${name} room; pick ${name} as your country to join it`);
    return { room: `country:${code}`, name };
  }
  if (room.startsWith('cult:')) {
    const clan = clans.get(room.slice(5));
    if (!clan || !clans.membership(clan.id, userId)) throw new ChatError(404, 'no such room');
    return { room, name: clan.name };
  }
  throw new ChatError(404, 'no such room');
}

// The rooms a member is in, for the chat list: global, their country, their cults.
export function roomsFor(userId: string): { id: string; kind: 'global' | 'country' | 'cult'; name: string }[] {
  const out: { id: string; kind: 'global' | 'country' | 'cult'; name: string }[] = [{ id: 'global', kind: 'global', name: 'Global' }];
  const cc = members.get(userId)?.country;
  const cn = cc ? countryName(cc) : null;
  if (cc && cn) out.push({ id: `country:${cc}`, kind: 'country', name: cn });
  for (const c of clans.forUser(userId)) out.push({ id: cultRoom(c.id), kind: 'cult', name: c.name });
  return out;
}

export function postMessage(room: string, userId: string, input: { body: string; replyTo?: string | null; markerId?: string | null }): ChatMessage {
  const body = input.body.trim();
  if (!body) throw new ChatError(400, 'message is empty');
  if (body.length > MAX_MESSAGE_CHARS) throw new ChatError(400, `message is over ${MAX_MESSAGE_CHARS} characters`);
  if (input.replyTo && !getDb().prepare('SELECT 1 FROM chat_messages WHERE id = ? AND room = ?').get(input.replyTo, room)) {
    throw new ChatError(404, 'the message you replied to is not in this room');
  }
  const now = Date.now();
  const mine = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= BURST) throw new ChatError(429, 'slow down a little');
  mine.push(now);
  recent.set(userId, mine);

  const row: Row = { id: randomUUID(), room, user_id: userId, body, reply_to: input.replyTo ?? null, marker_id: input.markerId ?? null, created_at: now };
  getDb()
    .prepare('INSERT INTO chat_messages (id, room, user_id, body, reply_to, marker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.room, row.user_id, row.body, row.reply_to, row.marker_id, row.created_at);
  const msg = toApi(row);
  clanBus.emit('message', room, msg);
  return msg;
}

// Newest page first by default; `before` (a message id) pages further back.
// Messages come back oldest to newest within the page, ready to render.
export function listMessages(room: string, opts: { before?: string; limit?: number } = {}): { messages: ChatMessage[]; hasMore: boolean } {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), PAGE_MAX);
  let cursor: number | null = null;
  if (opts.before) {
    const r = getDb().prepare('SELECT rowid AS seq FROM chat_messages WHERE id = ? AND room = ?').get(opts.before, room) as { seq: number } | undefined;
    if (!r) throw new ChatError(404, 'no such message in this room');
    cursor = r.seq;
  }
  const rows = getDb()
    .prepare(`SELECT * FROM chat_messages WHERE room = ? ${cursor != null ? 'AND rowid < ?' : ''} ORDER BY rowid DESC LIMIT ?`)
    .all(...(cursor != null ? [room, cursor, limit + 1] : [room, limit + 1])) as unknown as Row[];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map(toApi), hasMore };
}
