import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monDepositDescription } from '../src/api/balances.js';
import { usdcAddress } from '../src/chain/tokens.js';

test('testnet does not advertise USDC or MON-to-perp conversion', () => {
  assert.equal(usdcAddress(10143), null);
  assert.match(monDepositDescription(10143), /cannot be swapped/);
});
test('mainnet supports USDC and describes MON conversion', () => {
  assert.ok(usdcAddress(143));
  assert.match(monDepositDescription(143), /perps swap it/);
});
