import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeMirror, type SizingInput } from '../src/mirror/sizing.js';

const base: SizingInput = {
  leaderMarginFraction: 0.1,
  leaderLeverage: 5,
  marketMaxLeverage: 20,
  followerFreeBalanceUsd: 1000,
  markPrice: 50_000,
  sizeDecimals: 5,
  policy: { enabled: true, balancePercentCap: 25, maxUsdPerTrade: 10_000 },
};

test('proportional: follower uses the same fraction of their own balance', () => {
  const r = sizeMirror(base);
  assert.equal(r.ok, true);
  // 10% of 1000 = 100 margin, x5 = 500 notional, / 50k = 0.01
  assert.equal(r.size, 0.01);
  assert.equal(r.notionalUsd, 500);
  assert.deepEqual(r.capsApplied, ['none']);
});

test('balancePercentCap bounds the fraction', () => {
  const r = sizeMirror({ ...base, leaderMarginFraction: 0.8 });
  // capped to 25% -> 250 margin x5 = 1250 notional
  assert.equal(r.notionalUsd, 1250);
  assert.deepEqual(r.capsApplied, ['balance_percent_cap']);
});

test('maxUsdPerTrade bounds notional and never gets exceeded after rounding', () => {
  const r = sizeMirror({ ...base, markPrice: 33_333, policy: { ...base.policy, maxUsdPerTrade: 300 } });
  assert.ok(r.notionalUsd <= 300, `notional ${r.notionalUsd}`);
  assert.ok(r.capsApplied.includes('max_usd_per_trade'));
});

test('leader leverage above market max is clamped', () => {
  const r = sizeMirror({ ...base, leaderLeverage: 50 });
  assert.equal(r.leverage, 20);
  assert.ok(r.capsApplied.includes('market_max_leverage'));
});

test('disabled policy, zero balance, and dust all refuse instead of trading', () => {
  assert.equal(sizeMirror({ ...base, policy: { ...base.policy, enabled: false } }).ok, false);
  assert.equal(sizeMirror({ ...base, followerFreeBalanceUsd: 0 }).ok, false);
  assert.equal(sizeMirror({ ...base, followerFreeBalanceUsd: 0.0001 }).ok, false);
});

import { leaderDollarFraction } from '../src/mirror/sizing.js';

test('leader share with memes paid in dollars: the AUSD->MON swap just before the buy does not inflate it', () => {
  // Had $100 AUSD + 0.05 MON reserve. Swapped $10 -> ~380 MON, then bought with it.
  // Just before the buy: $90 AUSD + 380.05 MON (380 spendable) at $0.0263.
  const spent = 380 * 0.0263;
  const f = leaderDollarFraction({ spentUsd: spent, ausdBeforeUsd: 90, monBeforeWei: 380_050000000000000000n, reserveWei: 50000000000000000n, monPx: 0.0263 });
  assert.ok(Math.abs(f - spent / (90 + spent)) < 1e-12, `got ${f}`);
  assert.ok(f > 0.099 && f < 0.101, 'about 10%, not ~100%');
});

test('leader share with memes paid in MON excludes the gas reserve, like follower sizing does', () => {
  const px = 0.0266;
  const f = leaderDollarFraction({ spentUsd: 0.1 * px, ausdBeforeUsd: 0, monBeforeWei: 600000000000000000n, reserveWei: 50000000000000000n, monPx: px });
  assert.ok(Math.abs(f - 0.1 / 0.55) < 1e-9, `got ${f}`);
});

test('leader share is 0 with nothing spendable, capped at 1', () => {
  assert.equal(leaderDollarFraction({ spentUsd: 5, ausdBeforeUsd: 0, monBeforeWei: 10n, reserveWei: 50n, monPx: 1 }), 0);
  assert.equal(leaderDollarFraction({ spentUsd: 50, ausdBeforeUsd: 10, monBeforeWei: 0n, reserveWei: 0n, monPx: 1 }), 1);
});
