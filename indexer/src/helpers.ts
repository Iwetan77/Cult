import { BigDecimal } from "envio";

// Perpl collateral (AUSD) uses 6 decimals on-chain. `CNS` = collateral native
// scale, so raw amounts are USD * 1e6. Realized PnL in CNS converts to USD by
// dividing by 1e6 — no per-market scaling involved.
export const COLLATERAL_DECIMALS = 6;
const CNS_DIVISOR = new BigDecimal("1000000");

// Perpl testnet market config, snapshotted from GET /v1/pub/context.
// `priceDecimals` scales pricePNS, `sizeDecimals` scales lotLNS.
// NOTE: market ids are network-specific. This table is for Monad testnet (10143).
// Mainnet ids (1,10,20,31,40,50,60,70,90) need a separate table.
export interface MarketConfig {
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
}

export const MARKETS: Record<string, MarketConfig> = {
  "16": { symbol: "BTC", priceDecimals: 1, sizeDecimals: 5 },
  "32": { symbol: "ETH", priceDecimals: 2, sizeDecimals: 3 },
  "48": { symbol: "SOL", priceDecimals: 2, sizeDecimals: 3 },
  "64": { symbol: "MON", priceDecimals: 5, sizeDecimals: 0 },
  "256": { symbol: "ZEC", priceDecimals: 3, sizeDecimals: 3 },
  "272": { symbol: "LIT", priceDecimals: 5, sizeDecimals: 1 },
  "320": { symbol: "PUMP", priceDecimals: 6, sizeDecimals: 0 },
};

export function market(perpId: bigint): MarketConfig {
  return MARKETS[perpId.toString()] ?? { symbol: perpId.toString(), priceDecimals: 0, sizeDecimals: 0 };
}

export function symbolFor(perpId: bigint): string {
  return market(perpId).symbol;
}

// raw CNS (signed, USD * 1e6) -> USD BigDecimal
export function cnsToUsd(cns: bigint): BigDecimal {
  return new BigDecimal(cns.toString()).div(CNS_DIVISOR);
}

// raw PNS -> human price
export function pnsToPrice(pns: bigint, priceDecimals: number): BigDecimal {
  const scale = new BigDecimal((10n ** BigInt(priceDecimals)).toString());
  return new BigDecimal(pns.toString()).div(scale);
}

// raw LNS -> human size (base units)
export function lnsToSize(lns: bigint, sizeDecimals: number): BigDecimal {
  const scale = new BigDecimal((10n ** BigInt(sizeDecimals)).toString());
  return new BigDecimal(lns.toString()).div(scale);
}

// On-chain PositionType enum: 0 = Long, 1 = Short.
export function sideLabel(positionType: unknown): string {
  return Number(positionType) === 1 ? "SHORT" : "LONG";
}
