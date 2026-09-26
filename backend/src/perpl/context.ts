import { env } from '../config/env.js';
import type { Context, Market, MarketState } from './types.js';

// /v1/pub/context changes rarely (market list, fee schedule), so cache it for a
// minute. Everything that sizes or prices an order goes through here instead of
// hard-coding decimals or market ids.
const TTL_MS = 60_000;
let cached: { at: number; ctx: Context } | undefined;

export async function getContext(force = false): Promise<Context> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.ctx;
  const res = await fetch(`${env.perplApiUrl}/v1/pub/context`);
  if (!res.ok) throw new Error(`perpl context: ${res.status} ${await res.text()}`);
  const ctx = (await res.json()) as Context;
  cached = { at: Date.now(), ctx };
  return ctx;
}

export async function getMarket(marketId: number): Promise<Market> {
  const m = (await getContext()).markets.find((x) => x.id === marketId);
  if (!m) throw new Error(`unknown perpl market ${marketId}`);
  return m;
}

export async function getMarketBySymbol(symbol: string): Promise<Market> {
  const m = (await getContext()).markets.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!m) throw new Error(`perpl lists no market ${symbol}`);
  return m;
}

export interface ExchangeInfo {
  exchange: string;
  collateralToken: string;
  collateralDecimals: number;
  minAccountOpen: bigint;
  minDeposit: bigint;
}

export async function getExchangeInfo(): Promise<ExchangeInfo> {
  const ctx = await getContext();
  const inst = ctx.instances[0];
  if (!inst) throw new Error('perpl context has no exchange instance');
  const token = ctx.tokens.find((t) => t.id === inst.collateral_token_id);
  if (!token) throw new Error(`collateral token ${inst.collateral_token_id} missing from context`);
  return {
    exchange: inst.address,
    collateralToken: token.address,
    collateralDecimals: token.decimals,
    minAccountOpen: BigInt(inst.min_account_open_amount),
    minDeposit: BigInt(inst.min_deposit_amount),
  };
}

// Ticker: live mark/mid for every market, plus `sn` = the block it's current at,
// which is the only head-block source an HTTP-only client has.
export async function getTicker(): Promise<{ sn: number; d: Record<string, MarketState> }> {
  const res = await fetch(`${env.perplApiUrl}/v1/market-data/ticker`);
  if (!res.ok) throw new Error(`perpl ticker: ${res.status}`);
  return (await res.json()) as { sn: number; d: Record<string, MarketState> };
}

export const scale = {
  price: (human: number, m: Market) => Math.round(human * 10 ** m.config.price_decimals),
  size: (human: number, m: Market) => Math.floor(human * 10 ** m.config.size_decimals),
  unprice: (scaled: number, m: Market) => scaled / 10 ** m.config.price_decimals,
  unsize: (scaled: number, m: Market) => scaled / 10 ** m.config.size_decimals,
};

// Max leverage in Perpl's `lv` units (hundredths): 10000 / initial_margin * 100.
export function maxLeverageHundredths(m: Market): number {
  return Math.floor((10_000 / m.config.initial_margin) * 100);
}
