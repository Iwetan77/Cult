import { ethers } from 'ethers';
import { rpc } from '../chain/signer.js';
import type { MirrorEngine } from '../mirror/engine.js';
import type { LeaderTrade } from '../mirror/repo.js';
import { tokenAbi } from '../nadfun/trading.js';
import { getMarket } from '../perpl/context.js';
import { clans } from '../store/clans.js';
import { cultRoom, postSystem } from './chat.js';

// A cult's chat is also its activity feed: when a member opens, adds to,
// trims or closes a trade, a one-line notice goes into every cult they're in,
// pointing at that trade's chart marker.

const symbols = new Map<string, string>();
async function label(t: LeaderTrade): Promise<string> {
  if (t.venue === 'perpl') return (await getMarket(Number(t.market)).catch(() => null))?.symbol ?? `market ${t.market}`;
  if (!symbols.has(t.market)) {
    const sym: string = await new ethers.Contract(t.market, tokenAbi, rpc()).getFunction('symbol')().catch(() => '');
    symbols.set(t.market, sym ? `$${sym}` : `${t.market.slice(0, 8)}…`);
  }
  return symbols.get(t.market)!;
}

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
  for (const c of clans.forUser(t.userId)) postSystem(cultRoom(c.id), t.userId, body, `trade:${t.id}`);
}

export function startActivityFeed(engine: MirrorEngine) {
  const log = (e: unknown) => console.warn('[activity]', (e as Error).message);
  engine.on('trade', (t) => void announce(t, 'opened').catch(log));
  engine.on('tradeChanged', (t, ratio) => void announce(t, 'changed', ratio).catch(log));
  engine.on('tradeClosed', (t) => void announce(t, 'closed').catch(log));
}
