import { BigDecimal } from "envio";

// Perpl collateral (AUSD) uses 6 decimals on-chain. `CNS` = collateral native
// scale, so raw amounts are USD * 1e6. Realized PnL in CNS converts to USD by
// dividing by 1e6 — no per-market scaling involved.
export const COLLATERAL_DECIMALS = 6;
const CNS_DIVISOR = new BigDecimal("1000000");

// Perpl market config, snapshotted from GET /v1/pub/context on each network.
// `priceDecimals` scales pricePNS, `sizeDecimals` scales lotLNS. Market ids are
// network-specific but don't overlap, so one table serves testnet (10143:
// 16..320) and mainnet (143: 1..90). Mainnet names come from the market's
// `name` (its `symbol` is blank for BTC and MON there).
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
  // mainnet (app.perpl.xyz/api/v1/pub/context, 2026-09-27)
  "1": { symbol: "BTC", priceDecimals: 1, sizeDecimals: 5 },
  "10": { symbol: "MON", priceDecimals: 6, sizeDecimals: 0 },
  "20": { symbol: "ETH", priceDecimals: 2, sizeDecimals: 3 },
  "31": { symbol: "SOL", priceDecimals: 3, sizeDecimals: 3 },
  "40": { symbol: "HYPE", priceDecimals: 4, sizeDecimals: 2 },
  "50": { symbol: "ZEC", priceDecimals: 2, sizeDecimals: 4 },
  "60": { symbol: "LIT", priceDecimals: 5, sizeDecimals: 1 },
  "70": { symbol: "VVV", priceDecimals: 4, sizeDecimals: 2 },
  "90": { symbol: "PUMP", priceDecimals: 6, sizeDecimals: 0 },
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

// --- Nad.fun -------------------------------------------------------------

// MON is the native asset (18 decimals). Nad.fun amounts are in MON wei.
const MON_DIVISOR = new BigDecimal("1000000000000000000");

// raw MON wei (signed) -> MON BigDecimal
export function monWeiToMon(wei: bigint): BigDecimal {
  return new BigDecimal(wei.toString()).div(MON_DIVISOR);
}

// Ensures a `Trader` row exists with sane defaults. Shared by both venue
// handlers so the aggregate (tradeCount/winRate) counts both venues.
export async function ensureTrader(context: any, owner: string) {
  const t = await context.Trader.get(owner);
  if (!t) {
    context.Trader.set({
      id: owner,
      tradeCount: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      realizedPnlCNS: 0n,
      realizedPnlUsd: new BigDecimal("0"),
      realizedPnlMonWei: 0n,
      realizedPnlMon: new BigDecimal("0"),
    });
  }
}
