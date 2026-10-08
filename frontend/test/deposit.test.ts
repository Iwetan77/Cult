import assert from 'node:assert/strict';
import { test } from 'node:test';
import { depositInstruction, testnetDepositWarning } from '../src/lib/deposit';

const token = (symbol: 'MON' | 'USDC' | 'AUSD') => ({ symbol, name: symbol, what: '', balance: 0, balanceUsd: 0 });
test('testnet only advertises the supported deposit tokens', () => {
  assert.equal(depositInstruction({ network: { name: 'Monad testnet', chainId: 10143 }, tokens: [token('MON'), token('AUSD')] }), 'Send MON or AUSD on Monad testnet to this address.');
  assert.match(testnetDepositWarning, /USDC is not supported or converted/);
});
test('mainnet includes USDC when the backend offers it', () => {
  assert.equal(depositInstruction({ network: { name: 'Monad', chainId: 143 }, tokens: [token('MON'), token('USDC'), token('AUSD')] }), 'Send MON, USDC or AUSD on Monad to this address.');
});
test('missing deposit tokens never fall back to advertising unsupported coins', () => {
  assert.equal(depositInstruction({ network: { name: 'Monad', chainId: 143 }, tokens: [] }), 'Deposit options are unavailable. Do not send tokens yet.');
});
