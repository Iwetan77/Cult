import { getContext, getExchangeInfo, getMarket, getTicker, scale } from '../perpl/context.js';
import { listMonMarkets } from '../nadfun/trading.js';
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

const TTL_MS = 15_000;
let cache: { at: number; list: MarketListing[] } | undefined;

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

async function nadListings(): Promise<MarketListing[]> {
  const [list, monPx] = await Promise.all([listMonMarkets('market_cap', 50), monPriceAusd()]);
  return list.map((m) => ({
    venue: 'nadfun' as const,
    id: m.token.toLowerCase(),
    symbol: `$${m.symbol}`,
    name: m.name,
    priceUsd: m.priceMon ? m.priceMon * monPx : null,
    change24hPct: null,
    volume24hUsd: null,
    imageUri: m.imageUri ?? null,
    maxLeverage: 1,
  }));
}

async function all(): Promise<MarketListing[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  const [p, n] = await Promise.all([perplListings().catch(() => []), nadListings().catch(() => [])]);
  const list = [...p, ...n];
  if (list.length) cache = { at: Date.now(), list };
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
    list = list.filter((m) => m.symbol.toLowerCase().replace(/^\$/, '').includes(q) || m.name.toLowerCase().includes(q));
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
