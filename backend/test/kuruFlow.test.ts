import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { checkQuoteTx, flowAbi, KURU_FLOW_ROUTER, NATIVE } from '../src/swap/kuruFlow.js';

const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const want = { tokenIn: AUSD, tokenOut: NATIVE, amountIn: 10_000_000n };
const intent = (over: Partial<{ buys: string; min: bigint; sells: string; amt: bigint }> = {}) => [over.buys ?? NATIVE, over.min ?? 1n, over.sells ?? AUSD, over.amt ?? 10_000_000n];
const fee = (bps = 0n, ref = 0n) => [ethers.ZeroAddress, bps, ethers.ZeroAddress, ref, false];
const swapTx = (i = intent(), f = fee(), value = 0n, to = KURU_FLOW_ROUTER) => ({ to, value, data: flowAbi.encodeFunctionData('executeSwap', [i, f, '0x']) });

test('accepts a clean executeSwap quote', () => {
  assert.doesNotThrow(() => checkQuoteTx(swapTx(), want));
});

test('refuses executeSwapWithReceiver (pays someone else)', () => {
  const data = flowAbi.encodeFunctionData('executeSwapWithReceiver', [intent(), fee(), '0x', ethers.Wallet.createRandom().address]);
  assert.throws(() => checkQuoteTx({ to: KURU_FLOW_ROUTER, value: 0n, data }, want), /not executeSwap/);
});

test('refuses any router but Kuru', () => {
  assert.throws(() => checkQuoteTx(swapTx(undefined, undefined, 0n, ethers.Wallet.createRandom().address), want), /not the Kuru router/);
});

test('refuses fees, mismatched tokens or amounts, and wrong native value', () => {
  assert.throws(() => checkQuoteTx(swapTx(intent(), fee(10n)), want), /fees/);
  assert.throws(() => checkQuoteTx(swapTx(intent(), fee(0n, 5n)), want), /fees/);
  assert.throws(() => checkQuoteTx(swapTx(intent({ amt: 20_000_000n })), want), /sells/);
  assert.throws(() => checkQuoteTx(swapTx(intent({ buys: AUSD })), want), /different tokens/);
  assert.throws(() => checkQuoteTx(swapTx(intent(), fee(), 1n), want), /native/);
  // native in: value must equal the amount
  const monIn = { tokenIn: NATIVE, tokenOut: AUSD, amountIn: 5n };
  assert.doesNotThrow(() => checkQuoteTx(swapTx(intent({ buys: AUSD, sells: NATIVE, amt: 5n }), fee(), 5n), monIn));
  assert.throws(() => checkQuoteTx(swapTx(intent({ buys: AUSD, sells: NATIVE, amt: 5n }), fee(), 4n), monIn), /native/);
});
