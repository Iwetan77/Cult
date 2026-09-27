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

export type NotionalInput = Omit<SizingInput, 'markPrice' | 'sizeDecimals'>;
export type NotionalResult = Omit<SizingResult, 'size' | 'sizeScaled'>;

// Venue-agnostic half of the sizing: how much AUSD of notional this follower's
// mirror should be. The venue adapter turns notional into its own units.
export function mirrorNotional(i: NotionalInput, minNotional = 0): NotionalResult {
  const r = sizeMirror({ ...i, markPrice: 1, sizeDecimals: 6 });
  if (r.ok && r.notionalUsd < minNotional) {
    return { ok: false, reason: `mirror size $${r.notionalUsd.toFixed(2)} is under the $${minNotional} minimum`, leverage: r.leverage, marginUsd: r.marginUsd, notionalUsd: r.notionalUsd, capsApplied: r.capsApplied };
  }
  const { size: _s, sizeScaled: _ss, ...rest } = r;
  return rest;
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

// What share of a Nad.fun leader's spendable money a buy used, in dollars.
// Measured against everything they could have spent just before it (wallet
// AUSD + MON above the gas reserve). With memes paid in dollars the AUSD is
// swapped to MON a moment before the buy, so "MON spent / MON held" would read
// ~100%; the dollar total is the same before and after that swap, so this is
// right in both payment modes.
export function leaderDollarFraction(i: { spentUsd: number; ausdBeforeUsd: number; monBeforeWei: bigint; reserveWei: bigint; monPx: number }): number {
  const spendableMon = i.monBeforeWei > i.reserveWei ? i.monBeforeWei - i.reserveWei : 0n;
  const totalUsd = i.ausdBeforeUsd + (Number(spendableMon) / 1e18) * i.monPx;
  if (!(totalUsd > 0) || !(i.spentUsd > 0)) return 0;
  return Math.min(1, i.spentUsd / totalUsd);
}
