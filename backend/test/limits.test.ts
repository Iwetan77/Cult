import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTradeRoute, resetLimits, take } from '../src/api/limits.js';

test('a sliding window lets max hits through, then says when to come back', () => {
  resetLimits();
  const lim = { max: 3, windowMs: 1000 };
  assert.ok([0, 100, 200].every((t) => take('k', lim, t).ok));
  const r = take('k', lim, 300);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.retryAfterMs, 700, 'the first hit leaves the window at 1000');
  assert.ok(take('k', lim, 1001).ok, 'room again once the oldest hit is out');
  assert.ok(take('other', lim, 300).ok, 'keys are independent');
});

test('trade routes are the ones that send orders or transactions', () => {
  assert.ok(isTradeRoute('POST', '/v1/positions/open'));
  assert.ok(isTradeRoute('POST', '/v1/clans/abc/stack'));
  assert.ok(isTradeRoute('POST', '/v1/clans/abc/markers/trade:1/suggest-tpsl'));
  assert.ok(isTradeRoute('POST', '/v1/funding/usdc/confirm'));
  assert.ok(!isTradeRoute('GET', '/v1/positions'));
  assert.ok(!isTradeRoute('POST', '/v1/clans/abc/messages'));
});
