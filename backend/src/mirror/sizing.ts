import type { MirrorPolicy } from '../store/clans.js';

// Pure sizing for one follower's mirror of one leader trade. No I/O, so the
// rules can be tested exactly.
//
//   fraction   = leader's position collateral / leader's equity at open
//   margin     = follower free balance x min(fraction, balancePercentCap%)
//   notional   = margin x leverage, then capped at maxUsdPerTrade
//   size       = notional / mark, floored to the market's size step
//
// leverage is the leader's, clamped to the market max.

export interface SizingInput {
  leaderMarginFraction: number; // 0..1
  leaderLeverage: number; // e.g. 5 for 5x
  marketMaxLeverage: number;
  followerFreeBalanceUsd: number;
  markPrice: number;
  sizeDecimals: number;
  policy: MirrorPolicy;
}

export type CapApplied = 'none' | 'balance_percent_cap' | 'max_usd_per_trade' | 'market_max_leverage';

export interface SizingResult {
  ok: boolean;
  reason?: string;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  size: number; // human units
  sizeScaled: number;
  capsApplied: CapApplied[];
}

export function sizeMirror(i: SizingInput): SizingResult {
  const caps: CapApplied[] = [];
  const fail = (reason: string): SizingResult => ({
    ok: false,
    reason,
    leverage: 0,
    marginUsd: 0,
    notionalUsd: 0,
    size: 0,
    sizeScaled: 0,
    capsApplied: caps,
  });

  if (!i.policy.enabled) return fail('mirroring disabled by member');
  if (!(i.markPrice > 0)) return fail('no mark price');
  if (!(i.followerFreeBalanceUsd > 0)) return fail('no free balance');
  if (!(i.leaderMarginFraction > 0)) return fail('leader margin fraction is 0');

  let leverage = i.leaderLeverage;
  if (leverage > i.marketMaxLeverage) {
    leverage = i.marketMaxLeverage;
    caps.push('market_max_leverage');
  }

  const capFraction = i.policy.balancePercentCap / 100;
  let fraction = Math.min(i.leaderMarginFraction, 1);
  if (fraction > capFraction) {
    fraction = capFraction;
    caps.push('balance_percent_cap');
  }

  let marginUsd = i.followerFreeBalanceUsd * fraction;
  let notionalUsd = marginUsd * leverage;
  if (notionalUsd > i.policy.maxUsdPerTrade) {
    notionalUsd = i.policy.maxUsdPerTrade;
    marginUsd = notionalUsd / leverage;
    caps.push('max_usd_per_trade');
  }

  const unit = 10 ** i.sizeDecimals;
  const sizeScaled = Math.floor((notionalUsd / i.markPrice) * unit);
  if (sizeScaled <= 0) return fail(`mirror rounds to 0 size (notional $${notionalUsd.toFixed(2)})`);
  const size = sizeScaled / unit;
  // Recompute from the floored size so the reported notional never exceeds the cap.
  notionalUsd = size * i.markPrice;
  marginUsd = notionalUsd / leverage;

  return { ok: true, leverage, marginUsd, notionalUsd, size, sizeScaled, capsApplied: caps.length ? caps : ['none'] };
}
