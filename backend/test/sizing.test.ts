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
