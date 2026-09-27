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
  kind: 'text' | 'system'; // system: "joined the cult", "opened BTC-PERP long 5x" (render as a pill)
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
  kind?: string;
}

const toApi = (r: Row): ChatMessage => ({
  id: r.id,
  room: r.room,
  kind: r.kind === 'system' ? 'system' : 'text',
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

export interface ChatRoom {
  id: string;
  kind: 'global' | 'country' | 'cult';
  name: string;
  memberCount: number;
  lastMessage: ChatMessage | null; // for the "your groups" list: latest line and when
}

function roomMemberCount(room: string): number {
  const db = getDb();
  if (room === 'global') return (db.prepare('SELECT count(*) AS n FROM members').get() as { n: number }).n;
  if (room.startsWith('country:')) return (db.prepare('SELECT count(*) AS n FROM members WHERE country = ?').get(room.slice(8)) as { n: number }).n;
  return clans.members(room.slice(5)).length;
}

function lastMessage(room: string): ChatMessage | null {
  const r = getDb().prepare('SELECT * FROM chat_messages WHERE room = ? ORDER BY rowid DESC LIMIT 1').get(room) as Row | undefined;
  return r ? toApi(r) : null;
}

// The rooms a member is in, for the chat list: global, their country, their cults.
export function roomsFor(userId: string): ChatRoom[] {
  const base: Omit<ChatRoom, 'memberCount' | 'lastMessage'>[] = [{ id: 'global', kind: 'global', name: 'Global' }];
  const cc = members.get(userId)?.country;
  const cn = cc ? countryName(cc) : null;
  if (cc && cn) base.push({ id: `country:${cc}`, kind: 'country', name: cn });
  for (const c of clans.forUser(userId)) base.push({ id: cultRoom(c.id), kind: 'cult', name: c.name });
  return base.map((r) => ({ ...r, memberCount: roomMemberCount(r.id), lastMessage: lastMessage(r.id) }));
}

// A room event, not something a member typed: "joined the cult", "opened BTC-PERP
// long 5x". Attributed to the member it's about; no rate limit.
export function postSystem(room: string, userId: string, body: string, markerId: string | null = null): ChatMessage {
  const row: Row = { id: randomUUID(), room, user_id: userId, body, reply_to: null, marker_id: markerId, created_at: Date.now(), kind: 'system' };
  getDb()
    .prepare('INSERT INTO chat_messages (id, room, user_id, body, reply_to, marker_id, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.room, row.user_id, row.body, row.reply_to, row.marker_id, row.created_at, 'system');
  const msg = toApi(row);
  clanBus.emit('message', room, msg);
  return msg;
}

// What's pinned at the top of a room. Global and country rooms have a fixed
// welcome; a cult shows whatever its owner pinned.
export interface Pinned {
  id: string;
  memberName: string;
  body: string;
}
export function pinnedFor(room: string): Pinned | null {
  if (room === 'global') {
    return { id: 'welcome:global', memberName: 'Cult', body: 'Welcome to Global. Every trader on Cult starts here. Running a cult? Post it here and grow it.' };
  }
  if (room.startsWith('country:')) {
    const name = countryName(room.slice(8)) ?? 'your country';
    return { id: `welcome:${room}`, memberName: 'Cult', body: `Welcome to ${name}. Traders from ${name} meet here.` };
  }
  const clan = clans.get(room.slice(5));
  const pinId = clan ? (getDb().prepare('SELECT pinned_message_id AS p FROM clans WHERE id = ?').get(clan.id) as { p: string | null }).p : null;
  if (!pinId) return null;
  const r = getDb().prepare('SELECT * FROM chat_messages WHERE id = ? AND room = ?').get(pinId, room) as Row | undefined;
  return r ? { id: r.id, memberName: toApi(r).memberName, body: r.body } : null;
}

// The cult owner pins one of the room's messages (or clears it with null).
export function setPin(room: string, userId: string, messageId: string | null): Pinned | null {
  if (!room.startsWith('cult:')) throw new ChatError(403, 'only cult rooms can have a pin changed');
  const clan = clans.get(room.slice(5));
  if (!clan || clan.createdBy !== userId) throw new ChatError(403, 'only the cult owner can pin');
  if (messageId && !getDb().prepare('SELECT 1 FROM chat_messages WHERE id = ? AND room = ?').get(messageId, room)) throw new ChatError(404, 'no such message in this room');
  getDb().prepare('UPDATE clans SET pinned_message_id = ? WHERE id = ?').run(messageId, clan.id);
  return pinnedFor(room);
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
export function listMessages(room: string, opts: { before?: string; limit?: number } = {}): { messages: ChatMessage[]; hasMore: boolean; pinned: Pinned | null } {
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
  return { messages: rows.slice(0, limit).reverse().map(toApi), hasMore, pinned: pinnedFor(room) };
}
