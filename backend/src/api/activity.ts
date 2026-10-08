import type { MirrorEngine } from '../mirror/engine.js';
import { tradeCults, type LeaderTrade } from '../mirror/repo.js';
import { clans } from '../store/clans.js';
import { cultRoom, postSystem } from './chat.js';
import { marketSymbol } from './symbols.js';

// A cult's chat is also its activity feed: when a member opens, adds to,
// trims or closes a trade, a one-line notice goes into every cult it was posted
// to (all of theirs unless they picked),
// pointing at that trade's chart marker.

const label = (t: LeaderTrade) => marketSymbol(t.venue, t.market);

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;

export function describeTrade(t: LeaderTrade, what: 'opened' | 'changed' | 'closed', m: string, ratio = 1): string {
  const perp = t.venue === 'perpl';
  const pos = perp ? `${m} ${t.side} ${Math.round(t.leverage / 100)}x` : m;
  if (what === 'opened') return perp ? `opened ${pos}` : `bought ${m}`;
  if (what === 'closed') return perp ? `closed ${pos}` : `sold all ${m}`;
  return ratio > 1 ? (perp ? `added ${pct(ratio - 1)} to ${pos}` : `bought ${pct(ratio - 1)} more ${m}`) : `sold ${pct(1 - ratio)} of ${perp ? pos : m}`;
}

async function announce(t: LeaderTrade, what: 'opened' | 'changed' | 'closed', ratio?: number) {
  const body = describeTrade(t, what, await label(t), ratio);
  // Only to cults the trader shares with (admins), as the engine recorded it.
  for (const id of tradeCults(t, clans.adminCultIds(t.userId))) postSystem(cultRoom(id), t.userId, body, `trade:${t.id}`);
}

export function startActivityFeed(engine: MirrorEngine) {
  const log = (e: unknown) => console.warn('[activity]', (e as Error).message);
  engine.on('trade', (t) => void announce(t, 'opened').catch(log));
  engine.on('tradeChanged', (t, ratio) => void announce(t, 'changed', ratio).catch(log));
  engine.on('tradeClosed', (t) => void announce(t, 'closed').catch(log));
}
