// "Post to": a member trading from the app can pick which of their cults the
// trade goes to (its chat notices, its chart, its Auto-follow copies). The
// order is placed first and the trade is recognised a moment later from the
// venue, so the choice waits here, keyed by member + market, until the engine
// records the trade. Trades made outside the app reach every cult.

const TTL_MS = 3 * 60_000;
const pending = new Map<string, { cultIds: string[]; expires: number }>();
const key = (userId: string, venue: string, market: string) => `${userId}:${venue}:${market.toLowerCase()}`;

export function setAudience(userId: string, venue: string, market: string, cultIds: string[]) {
  pending.set(key(userId, venue, market), { cultIds, expires: Date.now() + TTL_MS });
}

export function clearAudience(userId: string, venue: string, market: string) {
  pending.delete(key(userId, venue, market));
}

// The member's pick for this trade, once; undefined = none (every cult).
export function takeAudience(userId: string, venue: string, market: string): string[] | undefined {
  const k = key(userId, venue, market);
  const hit = pending.get(k);
  pending.delete(k);
  return hit && hit.expires > Date.now() ? hit.cultIds : undefined;
}
