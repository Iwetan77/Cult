import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableTradeFunds } from '../src/lib/tradeFunds';

const balances = { perplMarginUsd: 5, walletUsd: 20, usdcUsd: 40, mon: 100.35, monUsd: 100.35, gasReserveMon: 0.25, lowGas: false, memesPayWith: 'mon' as const };

test('testnet MON and USDC are never counted as perp margin', () => {
  assert.equal(availableTradeFunds('perpl', balances, 1, 10143), 25);
  assert.equal(availableTradeFunds('perpl', { ...balances, perplMarginUsd: null, walletUsd: 0 }, 1, 10143), 0);
});

test('mainnet perps count convertible dollars and MON above the funding reserve', () => {
  assert.equal(availableTradeFunds('perpl', balances, 1, 143), 162);
});

test('testnet memes use only MON above the gas reserve', () => {
  assert.equal(availableTradeFunds('nadfun', balances, 1, 10143), 100.1);
  assert.equal(availableTradeFunds('nadfun', { ...balances, mon: 0.1 }, 1, 10143), 0);
});

test('mainnet memes use the larger available dollar or MON pocket', () => {
  assert.equal(availableTradeFunds('nadfun', { ...balances, mon: 1 }, 1, 143), 60);
});

test('funding cannot be estimated before the balance and network arrive', () => {
  assert.equal(availableTradeFunds('perpl', null, 1, 143), null);
  assert.equal(availableTradeFunds('perpl', balances, 1, undefined), null);
});
