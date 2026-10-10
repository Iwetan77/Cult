import type { MirrorEngine } from '../mirror/engine.js';
import { tradeCults, trades, type LeaderTrade, type Mirror } from '../mirror/repo.js';
import { clans } from '../store/clans.js';
import { getDb } from '../store/db.js';
import { cultRoom, postSystem } from './chat.js';
import { marketSymbol } from './symbols.js';

// A cult's chat is also its activity feed: when a member opens, adds to,
// trims or closes a trade, a one-line notice goes into every cult it was posted
// to (all of theirs unless they picked),
// pointing at that trade's chart marker.

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;

export function describeTrade(t: LeaderTrade, what: 'opened' | 'changed' | 'closed', m: string, ratio = 1): string {
  const perp = t.venue === 'perpl';
  const pos = perp ? `${m} ${t.side} ${Math.round(t.leverage / 100)}x` : m;
  if (what === 'opened') return perp ? `opened ${pos}` : `bought ${m}`;
  if (what === 'closed') return perp ? `closed ${pos}` : `sold all ${m}`;
  return ratio > 1 ? (perp ? `added ${pct(ratio - 1)} to ${pos}` : `bought ${pct(ratio - 1)} more ${m}`) : `sold ${pct(1 - ratio)} of ${perp ? pos : m}`;
}

async function announce(t: LeaderTrade, what: 'opened' | 'changed' | 'closed', ratio: number | undefined, symbol: typeof marketSymbol) {
  const prefixes = what === 'opened' ? ['opened %', 'bought %'] : what === 'closed' ? ['closed %', 'sold all %'] : [];
  const exists = (room: string) => prefixes.length > 0 && !!getDb().prepare(
    `SELECT 1 FROM chat_messages WHERE room = ? AND user_id = ? AND marker_id = ? AND kind = 'system'
       AND (${prefixes.map(() => 'body LIKE ?').join(' OR ')}) LIMIT 1`,
  ).get(room, t.userId, `trade:${t.id}`, ...prefixes);
  const rooms = tradeCults(t, clans.adminCultIds(t.userId)).map(cultRoom).filter(room => !exists(room));
  if (!rooms.length) return;
  const body = describeTrade(t, what, await symbol(t.venue, t.market), ratio);
  // A symbol lookup may yield to a replay of the same trade event.
  for (const room of rooms) if (!exists(room)) postSystem(room, t.userId, body, `trade:${t.id}`);
}

async function announceMirror(m: Mirror, symbol: typeof marketSymbol) {
  if (m.status !== 'open' && m.status !== 'closed') return;
  if (m.status === 'open' && (!m.size || BigInt(m.size) <= 0n || m.error?.startsWith('close failed:'))) return;
  const t = trades.get(m.tradeId);
  if (!t) return;
  const room = cultRoom(m.clanId);
  const marker = `mirror:${m.id}`;
  const opened = m.status === 'open';
  const prefixes = opened ? ['opened an automatic copy of %'] : ['closed their automatic copy of %', 'had already exited their automatic copy of %'];
  // Persisted notices are the deduplication record, including after a restart.
  const exists = () => getDb().prepare(
    `SELECT 1 FROM chat_messages WHERE room = ? AND user_id = ? AND marker_id = ? AND kind = 'system'
       AND (${prefixes.map(() => 'body LIKE ?').join(' OR ')}) LIMIT 1`,
  ).get(room, m.userId, marker, ...prefixes);
  if (exists()) return;
  const market = await symbol(t.venue, t.market);
  const position = t.venue === 'perpl' ? `${market} ${t.side}` : market;
  const action = opened ? 'opened an automatic copy of' : /member had already exited/i.test(m.error ?? '') ? 'had already exited their automatic copy of' : 'closed their automatic copy of';
  // Lookup can yield to another snapshot; check again immediately before posting.
  if (!exists()) postSystem(room, m.userId, `${action} ${position}`, marker);
}

const feeds = new WeakSet<MirrorEngine>();

export function startActivityFeed(engine: MirrorEngine, symbol: typeof marketSymbol = marketSymbol) {
  if (feeds.has(engine)) return;
  feeds.add(engine);
  const log = (e: unknown) => console.warn('[activity]', (e as Error).message);
  engine.on('trade', (t) => void announce(t, 'opened', undefined, symbol).catch(log));
  engine.on('tradeChanged', (t, ratio) => void announce(t, 'changed', ratio, symbol).catch(log));
  engine.on('tradeClosed', (t) => void announce(t, 'closed', undefined, symbol).catch(log));
  engine.on('mirror', (m) => void announceMirror(m, symbol).catch(log));
}
