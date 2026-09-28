import type { MarketDetail, MarketListing } from './contracts';

// Markets in memory, so going back to Markets or opening a market draws at
// once from what we last saw while a fresh copy loads quietly behind it.

const lists = new Map<string, MarketListing[]>();
const listings = new Map<string, MarketListing>();
const details = new Map<string, MarketDetail>();

const listKey = (query: string, venue?: string) => `${venue ?? 'all'}|${query.trim().toLowerCase()}`;

export function rememberList(query: string, venue: string | undefined, list: MarketListing[]) {
  lists.set(listKey(query, venue), list);
  for (const m of list) listings.set(m.id.toLowerCase(), m);
}

export function cachedList(query: string, venue?: string): MarketListing[] | null {
  return lists.get(listKey(query, venue)) ?? null;
}

export function rememberMarket(detail: MarketDetail) {
  details.set(`${detail.market.id.toLowerCase()}|${detail.resolution}`, detail);
  listings.set(detail.market.id.toLowerCase(), detail.market);
}

// The last full market (chart included), or at least its listing so the
// header can draw straight away.
export function cachedMarket(id: string, resolution: number): MarketDetail | null {
  const hit = details.get(`${id.toLowerCase()}|${resolution}`);
  if (hit) return hit;
  const listing = listings.get(id.toLowerCase());
  return listing ? { market: listing, candles: [], resolution } : null;
}
