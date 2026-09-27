import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceOf } from '../src/api/chart.js';
import type { Holding } from '../src/venues/types.js';

const perplPos: Holding = { venue: 'perpl', market: '16', symbol: 'BTC', side: 'long', sizeRaw: '100', size: 0.001, entryPriceAusd: 84000, markPriceAusd: 85000, valueAusd: 85, pnlAusd: 1, leverage: 3 };

test('a sub-1-BTC perpl position still values (the old bug read it as empty)', () => {
  const r = sliceOf('perpl', { ...perplPos, sizeRaw: '70', size: 0.0007, valueAusd: 59.5, pnlAusd: 0.7 }, '70', null);
  assert.equal(r.size, 0.0007);
  assert.equal(r.valueUsd, 59.5);
  assert.equal(r.pnlUsd, 0.7);
  assert.equal(r.entryPrice, 84000);
});

test('own trade + mirror on one perpl position split by raw size', () => {
  const mirror = sliceOf('perpl', perplPos, '30', null); // 30 of 100 raw
  assert.ok(Math.abs(mirror.size! - 0.0003) < 1e-12);
  assert.ok(Math.abs(mirror.valueUsd! - 25.5) < 1e-9);
  assert.ok(Math.abs(mirror.pnlUsd! - 0.3) < 1e-9);
});

test('a slice bigger than what is held is capped at the holding', () => {
  assert.equal(sliceOf('perpl', perplPos, '250', null).size, 0.001);
});

test('nadfun: pnl from the slice cost, value is liquidation value', () => {
  const h: Holding = { venue: 'nadfun', market: '0xabc', symbol: 'MOE', side: 'buy', sizeRaw: '2000000000000000000000', size: 2000, entryPriceAusd: null, markPriceAusd: 0.0009, valueAusd: 1.8, pnlAusd: null, leverage: 1 };
  const r = sliceOf('nadfun', h, '1000000000000000000000', 0.001); // half, bought at $0.001
  assert.equal(r.size, 1000);
  assert.ok(Math.abs(r.valueUsd! - 0.9) < 1e-12);
  assert.ok(Math.abs(r.pnlUsd! - -0.1) < 1e-12);
});

test('nothing held means nulls, not zeros', () => {
  assert.deepEqual(sliceOf('perpl', undefined, '10', 1), { entryPrice: 1, size: null, pnlUsd: null, valueUsd: null });
  assert.deepEqual(sliceOf('perpl', { ...perplPos, sizeRaw: '0' }, '10', null), { entryPrice: null, size: null, pnlUsd: null, valueUsd: null });
});
