import { randomUUID } from 'node:crypto';
import { clans } from '../store/clans.js';
import { getDb } from '../store/db.js';
import { CHAT_IMAGE_MAX_BYTES, chatImages, cultImages, decodeImage, ImageError } from '../store/media.js';
import { members } from '../store/members.js';
import { countryName } from './countries.js';
import { shortName } from './names.js';
import { clanBus } from './suggestions.js';
import { nameOf, avatarOf } from './names.js';

// Chat rooms, pushed live over SSE:
//   "global"        everyone on Cult
//   "country:NG"    members who picked that country
//   "cult:<id>"     that cult's members (its group chat)
// Text, a photo, or both. A message can point at a chart marker ("selling half
// of this"), a public cult ("cult:<id>") or a market's chart ("chart:<marketId>").
// Members react with emoji.

export const REACTIONS = ['🔥', '🚀', '💀', '👀', '😂'] as const;
// An emoji on a message: how many, and whether the one reading reacted with it.
export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface ChatMessage {
  id: string;
  room: string;
  kind: 'text' | 'system'; // system: "joined the cult", "opened BTC-PERP long 5x" (render as a pill)
  clanId: string | null; // set for cult rooms (kept for the cult chat's existing clients)
  memberId: string;
  memberName: string;
  memberAvatarUrl: string | null;
  body: string;
  text: string; // what to show: the body, or for a system notice "<name> <body>"
  replyTo: string | null;
  markerId: string | null;
  createdAt: string; // ISO
  imageUrl: string | null; // a photo sent with it (the body is then its caption, maybe empty)
  reactions: Reaction[];
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
  image_id?: string | null;
}

const toApi = (r: Row, reactions: Reaction[] = []): ChatMessage => ({
  id: r.id,
  room: r.room,
  kind: r.kind === 'system' ? 'system' : 'text',
  clanId: r.room.startsWith('cult:') ? r.room.slice(5) : null,
  memberId: r.user_id,
  memberName: nameOf(r.user_id),
  memberAvatarUrl: avatarOf(r.user_id),
  // System notices read as a sentence with the member's name: "iwetan joined the cult".
  text: r.kind === 'system' ? `${nameOf(r.user_id)} ${r.body}` : r.body,
  body: r.body,
  replyTo: r.reply_to,
  markerId: r.marker_id,
  createdAt: new Date(r.created_at).toISOString(),
  imageUrl: chatImages.url(r.image_id),
  reactions,
});

// Reactions on these messages, as the viewer sees them: emojis in the order
// they were first used, with counts, and which ones are the viewer's own.
function reactionsFor(ids: string[], viewerId: string | null): Map<string, Reaction[]> {
  const out = new Map<string, Reaction[]>();
  if (!ids.length) return out;
  const rows = getDb()
    .prepare(
      `SELECT message_id AS m, emoji, count(*) AS n, max(user_id = ?) AS mine, min(created_at) AS first
         FROM chat_reactions WHERE message_id IN (${ids.map(() => '?').join(',')})
        GROUP BY message_id, emoji ORDER BY first`,
    )
    .all(viewerId ?? '', ...ids) as { m: string; emoji: string; n: number; mine: number }[];
  for (const r of rows) {
    const list = out.get(r.m) ?? [];
    list.push({ emoji: r.emoji, count: r.n, mine: r.mine === 1 });
    out.set(r.m, list);
  }
  return out;
}

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
  icon: string; // G for Global, the country's flag, the cult's picture (a /v1 URL) or its first letter
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
  const base: Omit<ChatRoom, 'memberCount' | 'lastMessage' | 'icon'>[] = [{ id: 'global', kind: 'global', name: 'Global' }];
  const cc = members.get(userId)?.country;
  const cn = cc ? countryName(cc) : null;
  if (cc && cn) base.push({ id: `country:${cc}`, kind: 'country', name: cn });
  for (const c of clans.forUser(userId)) base.push({ id: cultRoom(c.id), kind: 'cult', name: c.name });
  return base.map((r) => ({ ...r, icon: roomIcon(r), memberCount: roomMemberCount(r.id), lastMessage: lastMessage(r.id) }));
}

// Regional-indicator letters make the flag emoji: NG -> 🇳🇬.
const flag = (cc: string) => String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
function roomIcon(r: { id: string; kind: string; name: string }): string {
  if (r.kind === 'global') return 'G'; // a letter badge like cults, until Global gets its own image
  if (r.kind === 'country') return flag(r.id.slice(8));
  return cultImages.url(r.id.slice(5)) ?? (r.name.trim()[0] ?? '?').toUpperCase();
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
  return r ? { id: r.id, memberName: toApi(r).memberName, body: r.body || (r.image_id ? 'Photo' : '') } : null;
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

// image: a photo as a data URL (resized in the browser); the body may then be empty.
export function postMessage(room: string, userId: string, input: { body: string; replyTo?: string | null; markerId?: string | null; image?: string | null }): ChatMessage {
  const body = input.body.trim();
  let image = null;
  try {
    image = input.image ? decodeImage(input.image, CHAT_IMAGE_MAX_BYTES) : null;
  } catch (e) {
    throw new ChatError(400, e instanceof ImageError ? e.message : 'that photo could not be read');
  }
  if (!body && !image) throw new ChatError(400, 'message is empty');
  if (body.length > MAX_MESSAGE_CHARS) throw new ChatError(400, `message is over ${MAX_MESSAGE_CHARS} characters`);
  if (input.replyTo && !getDb().prepare('SELECT 1 FROM chat_messages WHERE id = ? AND room = ?').get(input.replyTo, room)) {
    throw new ChatError(404, 'the message you replied to is not in this room');
  }
  const now = Date.now();
  const mine = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= BURST) throw new ChatError(429, 'slow down a little');
  mine.push(now);
  recent.set(userId, mine);

  const row: Row = { id: randomUUID(), room, user_id: userId, body, reply_to: input.replyTo ?? null, marker_id: input.markerId ?? null, created_at: now, image_id: image ? randomUUID() : null };
  const db = getDb();
  db.exec('BEGIN');
  try {
    if (image && row.image_id) chatImages.put(row.image_id, room, image);
    db.prepare('INSERT INTO chat_messages (id, room, user_id, body, reply_to, marker_id, created_at, image_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id,
      row.room,
      row.user_id,
      row.body,
      row.reply_to,
      row.marker_id,
      row.created_at,
      row.image_id ?? null,
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const msg = toApi(row);
  clanBus.emit('message', room, msg);
  return msg;
}

// A member reacts to a message with one of REACTIONS; the same emoji again
// takes it back. Returns the message's reactions as that member sees them.
export function react(room: string, userId: string, messageId: string, emoji: string): Reaction[] {
  if (!(REACTIONS as readonly string[]).includes(emoji)) throw new ChatError(400, `react with one of ${REACTIONS.join(' ')}`);
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM chat_messages WHERE id = ? AND room = ?').get(messageId, room)) throw new ChatError(404, 'no such message in this room');
  const removed = db.prepare('DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji);
  if (!Number(removed.changes)) db.prepare('INSERT INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(messageId, userId, emoji, Date.now());
  return reactionsFor([messageId], userId).get(messageId) ?? [];
}

// Newest page first by default; `before` (a message id) pages further back.
// Messages come back oldest to newest within the page, ready to render, with
// their reactions as `viewerId` sees them.
export function listMessages(room: string, opts: { before?: string; limit?: number; viewerId?: string } = {}): { messages: ChatMessage[]; hasMore: boolean; pinned: Pinned | null } {
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
  const page = rows.slice(0, limit).reverse();
  const reactions = reactionsFor(page.map((r) => r.id), opts.viewerId ?? null);
  return { messages: page.map((r) => toApi(r, reactions.get(r.id))), hasMore, pinned: pinnedFor(room) };
}
