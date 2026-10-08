import assert from 'node:assert/strict';
import { test } from 'node:test';
import { depositTokensFor, depositTotalUsd, monDepositDescription } from '../src/api/balances.js';
import { usdcAddress } from '../src/chain/tokens.js';

test('testnet does not advertise USDC or MON-to-perp conversion', () => {
  assert.equal(usdcAddress(10143), null);
  assert.match(monDepositDescription(10143), /cannot be swapped/);
});
test('mainnet supports USDC and describes MON conversion', () => {
  assert.ok(usdcAddress(143));
  assert.match(monDepositDescription(143), /perps swap it/);
});
const balances = { mon: 0.41409, monUsd: 0.01, walletUsd: 880 };
test('received testnet USDC is visible but never treated as trading collateral', () => {
  const tokens = depositTokensFor(balances, 10143, 40);
  const usdc = tokens.find(t => t.symbol === 'USDC')!;
  assert.equal(usdc.balance, 40);
  assert.equal(usdc.balanceUsd, null);
  assert.equal(usdc.depositSupported, false);
  assert.equal(depositTotalUsd(tokens, 9.78), 889.79);
  assert.equal(usdcAddress(10143), null, 'read visibility must not enable mainnet swap policies on testnet');
});
test('mainnet USDC still counts toward the dollar total', () => {
  const tokens = depositTokensFor(balances, 143, 40);
  assert.equal(tokens.find(t => t.symbol === 'USDC')!.depositSupported, true);
  assert.equal(depositTotalUsd(tokens, 9.78), 929.79);
});
test('unavailable USDC reads remain unknown rather than fabricated zero balances', () => {
  const testnet = depositTokensFor(balances, 10143, null);
  assert.equal(testnet.find(t => t.symbol === 'USDC')!.balance, null);
  assert.equal(depositTotalUsd(testnet, 9.78), 889.79);
  assert.equal(depositTotalUsd(depositTokensFor(balances, 143, null), 9.78), null);
});
