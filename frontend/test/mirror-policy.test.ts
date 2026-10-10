import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoFollowDraft, mirrorPolicyFromDraft, validateMirrorPolicy } from '../src/lib/mirrorPolicy';

const defaults = { maxUsdPerTrade: 100, balancePercentCap: 10 };

test('saving limits preserves the independent exit choice', () => {
  assert.equal(mirrorPolicyFromDraft('25', '5', false).followExits, false);
  assert.equal(mirrorPolicyFromDraft('25', '5', true).followExits, true);
});

test('saved personal limits survive turning copying off and on', () => {
  const draft = autoFollowDraft({ enabled: false, maxUsdPerTrade: 23.75, balancePercentCap: 0.5 }, defaults);
  assert.deepEqual(draft, { maxUsd: '23.75', balancePct: '0.5' });
  assert.deepEqual(mirrorPolicyFromDraft(draft.maxUsd, draft.balancePct), {
    enabled: true, maxUsdPerTrade: 23.75, balancePercentCap: 0.5,
  });
});

test('each cult starts from its own member policy without mutating it', () => {
  const first = { enabled: true, maxUsdPerTrade: 25, balancePercentCap: 2.5 };
  const second = { enabled: true, maxUsdPerTrade: 1500.25, balancePercentCap: 20 };
  assert.deepEqual(autoFollowDraft(first, defaults), { maxUsd: '25', balancePct: '2.5' });
  assert.deepEqual(autoFollowDraft(second, defaults), { maxUsd: '1500.25', balancePct: '20' });
  assert.equal(first.maxUsdPerTrade, 25);
  assert.equal(second.maxUsdPerTrade, 1500.25);
});

test('config suggestions are used only without a saved policy', () => {
  assert.deepEqual(autoFollowDraft(null, { maxUsdPerTrade: 75, balancePercentCap: 15 }), { maxUsd: '75', balancePct: '15' });
  assert.deepEqual(autoFollowDraft(null, undefined), { maxUsd: '100', balancePct: '10' });
});

test('exact inputs accept the full contract range without slider rounding', () => {
  for (const [maxUsd, balancePct] of [['1', '0.01'], ['23.75', '2.5'], ['1500.25', '10'], ['1000000', '100']]) {
    assert.deepEqual(mirrorPolicyFromDraft(maxUsd, balancePct), {
      enabled: true, maxUsdPerTrade: Number(maxUsd), balancePercentCap: Number(balancePct),
    });
  }
});

test('invalid dollar and percentage caps fail before a signing request', () => {
  for (const maxUsd of ['', ' ', '0', '-1', '0.99', '1000000.01', 'NaN', 'Infinity', 'abc']) {
    assert.throws(() => mirrorPolicyFromDraft(maxUsd, '10'), /maximum copy value/);
  }
  for (const balancePct of ['', ' ', '0', '-1', '100.01', 'NaN', 'Infinity', 'abc']) {
    assert.throws(() => mirrorPolicyFromDraft('25', balancePct), /free balance cap/);
  }
  assert.throws(() => validateMirrorPolicy({ enabled: true, maxUsdPerTrade: Infinity, balancePercentCap: 10 }), /maximum copy value/);
  assert.throws(() => validateMirrorPolicy({ enabled: true, maxUsdPerTrade: 25, balancePercentCap: NaN }), /free balance cap/);
});
