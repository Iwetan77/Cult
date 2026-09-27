import { numEnv } from '../config/env.js';
// Per-caller request limits, in memory (one backend process). Sliding window:
// each key keeps the timestamps of its recent hits.

export interface Limit {
  max: number;
  windowMs: number;
}

// Everything a signed-in member does, per member.
export const MEMBER_LIMIT: Limit = { max: numEnv('RATE_MEMBER_PER_MIN', 240), windowMs: 60_000 };
// Anything that sends an order or a transaction, per member, on top of the above.
export const TRADE_LIMIT: Limit = { max: numEnv('RATE_TRADE_PER_MIN', 20), windowMs: 60_000 };
// Public routes, per IP.
export const PUBLIC_LIMIT: Limit = { max: numEnv('RATE_PUBLIC_PER_MIN', 120), windowMs: 60_000 };

const hits = new Map<string, number[]>();

// Records a hit and says whether it's allowed. When it isn't, retryAfterMs is
// how long until the oldest hit in the window falls out.
export function take(key: string, limit: Limit, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < limit.windowMs);
  if (recent.length >= limit.max) {
    hits.set(key, recent);
    return { ok: false, retryAfterMs: limit.windowMs - (now - recent[0]!) };
  }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true };
}

// Drop keys that have gone quiet so the map doesn't grow forever.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of hits) if (ts.length === 0 || now - ts[ts.length - 1]! > 10 * 60_000) hits.delete(k);
}, 60_000);
sweep.unref();

export function resetLimits() {
  hits.clear();
}

// Routes that send orders or transactions.
const TRADE_ROUTES: RegExp[] = [
  /^\/v1\/positions\/(open|close|tpsl)$/,
  /^\/v1\/clans\/[^/]+\/stack$/,
  /^\/v1\/clans\/[^/]+\/markers\/[^/]+\/suggest-tpsl$/,
  /^\/v1\/funding\/usdc\/(prepare|confirm)$/,
];
export const isTradeRoute = (method: string, path: string) => method === 'POST' && TRADE_ROUTES.some((r) => r.test(path));
