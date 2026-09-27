// Spike C gate: one real Nad.fun buy and sell on testnet, executed
// programmatically against the v2 router. Proof is read back from chain: the
// router's own Buy/Sell events in each receipt, and the token balance going
// 0 -> N -> 0. Uses a fresh wallet seeded with MON by the funder.
import { mkdirSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { LocalKeySigner, rpc } from '../../src/chain/signer.js';
import { NADFUN } from '../../src/nadfun/constants.js';
import { buy, listMonMarkets, quoteBuy, sell, tokenBalance } from '../../src/nadfun/trading.js';
import { funder, newThrowaway, sweepBack } from '../e2e/fund.js';

const SPEND = ethers.parseEther(process.env.NAD_SPEND_MON ?? '0.01');
const GAS = ethers.parseEther(process.env.NAD_GAS_MON ?? '0.2');
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), router: NADFUN.router };
let me: LocalKeySigner | undefined;

try {
  const f = funder();
  const bal = await rpc().getBalance(f.address);
  if (bal < SPEND + GAS + ethers.parseEther('0.02')) {
    throw new Error(`funder ${f.address} has ${ethers.formatEther(bal)} MON, needs ${ethers.formatEther(SPEND + GAS + ethers.parseEther('0.02'))}`);
  }

  // A MON-quoted token that actually quotes > 0 right now.
  let target: Awaited<ReturnType<typeof listMonMarkets>>[number] | undefined;
  for (const m of await listMonMarkets('latest_trade', 100)) {
    if ((await quoteBuy(m.token, SPEND).catch(() => 0n)) > 0n) {
      target = m;
      break;
    }
  }
  if (!target) throw new Error('no MON-quoted Nad.fun token quoting a buy right now');
  console.log('token', target.symbol, target.token, target.graduated ? '(DEX)' : '(curve)');
  evidence.token = target;

  me = newThrowaway('spikeC');
  const seedTx = await f.sendTransaction({ to: me.address, data: '0x', value: SPEND + GAS });
  console.log('fresh wallet', me.address, 'seeded', seedTx);
  evidence.wallet = me.address;
  evidence.seedTx = seedTx;

  const before = await tokenBalance(target.token, me.address);
  const b = await buy(me, target.token, SPEND);
  const mid = await tokenBalance(target.token, me.address);
  console.log(`BUY  ${b.txHash}: ${ethers.formatEther(b.monAmount)} MON -> ${ethers.formatEther(b.tokenAmount)} ${target.symbol}`);

  const s = await sell(me, target.token);
  const after = await tokenBalance(target.token, me.address);
  console.log(`SELL ${s.txHash}: ${ethers.formatEther(s.tokenAmount)} ${target.symbol} -> ${ethers.formatEther(s.monAmount)} MON (approve ${s.approveTx})`);

  const stringify = (x: object) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  evidence.buy = stringify(b);
  evidence.sell = stringify(s);
  evidence.balances = { before: before.toString(), afterBuy: mid.toString(), afterSell: after.toString() };

  const problems: string[] = [];
  if (before !== 0n) problems.push('fresh wallet already held the token');
  if (mid !== b.tokenAmount) problems.push(`balance after buy ${mid} != Buy.amountOut ${b.tokenAmount}`);
  if (after !== 0n) problems.push(`balance after sell ${after}, expected 0`);
  if (s.tokenAmount !== b.tokenAmount) problems.push('sold amount != bought amount');
  if (problems.length) throw new Error('GATE FAILED: ' + problems.join('; '));
  console.log('\nGATE OK');
  evidence.result = 'pass';
} catch (e) {
  evidence.result = 'fail';
  evidence.error = String(e);
  console.error(e);
  process.exitCode = 1;
} finally {
  if (me) evidence.sweep = await sweepBack(me).catch((e) => String(e));
  mkdirSync('data/evidence', { recursive: true });
  const file = `data/evidence/spikeC-nadfun-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log('evidence ->', file);
}
