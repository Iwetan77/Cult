import { getContext, getExchangeInfo, getMarket, getTicker, scale } from '../perpl/context.js';
import { listMonMarkets, searchMonMarkets, type NadMarket } from '../nadfun/trading.js';
import { monPriceAusd } from '../prices.js';
import { venue as venueOf } from '../venues/index.js';
import { nadCandles, nadMarket, perplCandles, toApiMarket } from './chart.js';

// One market list across both venues, for the Markets page, search and
// "trending": Perpl perps (BTC-PERP ...) and MON-quoted Nad.fun memes ($MOE).
// Prices in $. Tapping one opens GET /v1/markets/:id (chart + price) and
// trading goes through POST /v1/positions/open.

export interface MarketListing {
  venue: 'perpl' | 'nadfun';
  id: string; // perpl market id | token address
  symbol: string; // "BTC-PERP" | "$MOE"
  name: string;
  priceUsd: number | null;
  change24hPct: number | null; // perpl only (vs the price 24h ago)
  volume24hUsd: number | null; // perpl only
  imageUri: string | null; // nad.fun token art
  maxLeverage: number; // nad.fun: 1
}

export class MarketError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

// Served from memory and refreshed in the background, so opening Markets never
// waits on Perpl and Nad.fun (warmMarkets() at boot keeps it fresh).
const TTL_MS = 15_000;
let cache: { at: number; list: MarketListing[] } | undefined;
let refreshing: Promise<MarketListing[]> | undefined;

async function perplListings(): Promise<MarketListing[]> {
  const [ctx, ticker, { collateralDecimals }] = await Promise.all([getContext(), getTicker(), getExchangeInfo()]);
  return ctx.markets
    .filter((m) => m.config.is_open)
    .map((m) => {
      const t = ticker.d[String(m.id)] as (typeof ticker.d)[string] & { prv?: number; dva?: string };
      const px = t?.mrk ? scale.unprice(t.mrk, m) : null;
      const prev = t?.prv ? scale.unprice(t.prv, m) : null;
      return {
        venue: 'perpl' as const,
        id: String(m.id),
        symbol: `${m.symbol}-PERP`,
        name: m.name || m.symbol,
        priceUsd: px,
        change24hPct: px != null && prev ? ((px - prev) / prev) * 100 : null,
        volume24hUsd: t?.dva ? Number(t.dva) / 10 ** collateralDecimals : null,
        imageUri: null,
        maxLeverage: toApiMarket(m).maxLeverage,
      };
    });
}

const nadListing = (m: NadMarket, monPx: number): MarketListing => ({
  venue: 'nadfun',
  id: m.token.toLowerCase(),
  symbol: `$${m.symbol}`,
  name: m.name,
  priceUsd: m.priceMon ? m.priceMon * monPx : null,
  change24hPct: null,
  volume24hUsd: null,
  imageUri: m.imageUri ?? null,
  maxLeverage: 1,
});

async function nadListings(): Promise<MarketListing[]> {
  const [list, monPx] = await Promise.all([listMonMarkets('market_cap', 100), monPriceAusd()]);
  return list.map((m) => nadListing(m, monPx));
}

function refresh(): Promise<MarketListing[]> {
  refreshing ??= Promise.all([perplListings().catch(() => []), nadListings().catch(() => [])])
    .then(([p, n]) => {
      const list = [...p, ...n];
      if (list.length) cache = { at: Date.now(), list };
      return list.length ? list : (cache?.list ?? []);
    })
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

async function all(): Promise<MarketListing[]> {
  if (cache) {
    if (Date.now() - cache.at >= TTL_MS) void refresh();
    return cache.list;
  }
  return refresh();
}

export function warmMarkets(): () => void {
  void refresh();
  const timer = setInterval(() => void refresh(), TTL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// Memes matching a search, straight from Nad.fun, cached briefly per keyword.
const searches = new Map<string, { at: number; list: MarketListing[] }>();
async function searchNad(q: string): Promise<MarketListing[]> {
  const hit = searches.get(q);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const [found, monPx] = await Promise.all([searchMonMarkets(q), monPriceAusd()]);
  const list = found.map((m) => nadListing(m, monPx));
  if (searches.size > 500) searches.clear();
  searches.set(q, { at: Date.now(), list });
  return list;
}

// A token Cult hasn't listed yet, looked up by address (search by contract).
async function tokenListing(address: string): Promise<MarketListing | null> {
  const m = await nadMarket(address).catch(() => null);
  if (!m || m.symbol === 'TOKEN') return null;
  const px = await venueOf('nadfun').markPriceAusd(address).catch(() => 0);
  return { venue: 'nadfun', id: address.toLowerCase(), symbol: `$${m.symbol}`, name: m.symbol, priceUsd: px || null, change24hPct: null, volume24hUsd: null, imageUri: m.imageUri ?? null, maxLeverage: 1 };
}

export async function listMarkets(opts: { q?: string; venue?: 'perpl' | 'nadfun'; limit?: number } = {}): Promise<MarketListing[]> {
  let list = await all();
  if (opts.venue) list = list.filter((m) => m.venue === opts.venue);
  const q = opts.q?.trim().toLowerCase().replace(/^\$/, '');
  if (q) {
    if (/^0x[0-9a-f]{40}$/.test(q)) {
      const hit = list.find((m) => m.id === q) ?? (await tokenListing(q));
      return hit ? [hit] : [];
    }
    const matches = (m: MarketListing) => m.symbol.toLowerCase().replace(/^\$/, '').includes(q) || m.name.toLowerCase().includes(q);
    list = list.filter(matches);
    // Then any other meme on Nad.fun whose name or symbol matches (its search
    // also returns unrelated tokens, so those are dropped).
    if (opts.venue !== 'perpl' && q.length >= 2) {
      const seen = new Set(list.map((m) => m.id));
      const more = await searchNad(q).catch(() => []);
      list = [...list, ...more.filter((m) => !seen.has(m.id) && matches(m))];
    }
  }
  return list.slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 200));
}

export interface MarketDetail {
  market: MarketListing;
  candles: { time: number; open: number; high: number; low: number; close: number }[];
  resolution: number;
}

export async function marketDetail(id: string, resolutionSec = 300): Promise<MarketDetail> {
  const isToken = /^0x[0-9a-fA-F]{40}$/.test(id);
  const market = (await all()).find((m) => m.id === id.toLowerCase()) ?? (isToken ? await tokenListing(id) : null);
  if (!market) throw new MarketError(404, 'no such market');
  const candles = await (isToken ? nadCandles(market.id, resolutionSec) : perplCandles(await getMarket(Number(market.id)), resolutionSec)).catch(() => []);
  return { market, candles, resolution: resolutionSec };
}
