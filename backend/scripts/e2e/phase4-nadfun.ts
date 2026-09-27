// Phase 4 gate, Nad.fun half (the Perpl half needs Perpl testnet AUSD, which
// the product owner doesn't have yet; see phase4.ts for both together).
//
// 3 fresh testnet wallets funded with MON only, one clan:
//   A buys a MON-quoted token on its own (not an engine order) ->
//   the router log watcher sees it and makes A the leader ->
//   B and C get mirror buys after the opt-out window, sized from their own
//   MON balance: B by the leader's fraction, C clamped by balancePercentCap ->
//   A sells everything -> the engine sells B's and C's mirrored slices.
// Proof is read from chain (token balances + router events), not our DB.
//
// Testnet MON is ~$0.027 at Perpl's mark, so with a few MON each mirror is a
// fraction of 1 AUSD. The dust floor is lowered for this run only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { registerSigner } from '../../src/accounts/signers.js';
import { LocalKeySigner, rpc } from '../../src/chain/signer.js';
import { MirrorEngine } from '../../src/mirror/engine.js';
import { mirrors, trades } from '../../src/mirror/repo.js';
import { mirrorNotional } from '../../src/mirror/sizing.js';
import { NadWatcher } from '../../src/nadfun/watcher.js';
import { listMonMarkets, quoteBuy, routerAbi, tokenBalance } from '../../src/nadfun/trading.js';
import { GAS_RESERVE_WEI } from '../../src/venues/nadfun.js';
import { NADFUN } from '../../src/nadfun/constants.js';
import { monPriceAusd } from '../../src/prices.js';
import { clans, type MirrorPolicy } from '../../src/store/clans.js';
import { members } from '../../src/store/members.js';
import { venue } from '../../src/venues/index.js';
import { funder, newThrowaway, sweepBack } from './fund.js';

const FUND_EACH = ethers.parseEther(process.env.NAD_E2E_MON_EACH ?? '0.6');
const LEADER_BUY_MON = Number(process.env.NAD_E2E_LEADER_BUY_MON ?? '0.1');
const OPT_OUT = 4;
const POLICY_B: MirrorPolicy = { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 };
const POLICY_C: MirrorPolicy = { enabled: true, balancePercentCap: 5, maxUsdPerTrade: 1000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), router: NADFUN.router };
const problems: string[] = [];
let engine: MirrorEngine | undefined;
const users: { name: string; userId: string; address: string; signer: LocalKeySigner }[] = [];

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  throw new Error(`timed out: ${what}`);
}

try {
  const f = funder();
  const need = FUND_EACH * 3n + ethers.parseEther('0.05');
  const have = await rpc().getBalance(f.address);
  if (have < need) throw new Error(`funder has ${ethers.formatEther(have)} MON, needs ${ethers.formatEther(need)}`);

  // Fresh wallets, MON only.
  for (const name of ['A', 'B', 'C']) {
    const signer = newThrowaway(`phase4-nadfun-${name}`);
    const w = signer.wallet;
    const seed = await f.sendTransaction({ to: w.address, data: '0x', value: FUND_EACH });
    const userId = `e2e-nad:${name}:${w.address.toLowerCase()}`;
    members.upsert(userId, w.address);
    registerSigner(userId, signer);
    users.push({ name, userId, address: w.address, signer });
    evidence[`wallet${name}`] = { address: w.address, seedTx: seed };
    console.log(name, w.address, 'seeded', seed);
  }
  const [A, B, C] = users as [(typeof users)[0], (typeof users)[0], (typeof users)[0]];
  const clan = clans.create(`e2e-nad-${Date.now()}`, A.userId, { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  clans.join(clan.id, B.userId, POLICY_B);
  clans.join(clan.id, C.userId, POLICY_C);

  engine = new MirrorEngine({ optOutSeconds: OPT_OUT, minMirrorAusd: 0.00001 }, { sessionFor: async () => { throw new Error('no perpl in this run'); }, nadWatcher: new NadWatcher(1000) });
  await engine.start();

  let token = '';
  for (const m of await listMonMarkets('latest_trade', 100)) {
    if (!m.graduated && (await quoteBuy(m.token, ethers.parseEther('0.01')).catch(() => 0n)) > 0n) {
      token = m.token.toLowerCase();
      evidence.token = m;
      break;
    }
  }
  if (!token) throw new Error('no MON-quoted curve token quoting a buy');
  console.log('token', token);

  // Expected mirror spend from each follower's balance at fire time (read now; nothing moves them until then).
  const monPx = await monPriceAusd();
  const freeB = Number(ethers.formatEther((await rpc().getBalance(B.address)) - GAS_RESERVE_WEI)) * monPx;
  const freeC = Number(ethers.formatEther((await rpc().getBalance(C.address)) - GAS_RESERVE_WEI)) * monPx;

  // A trades on its own. Signed by A's key, not tagged: must be detected as a leader trade.
  const aBuy = await venue('nadfun').open({ userId: A.userId, market: token, side: 'buy', notionalAusd: LEADER_BUY_MON * monPx });
  console.log('A buy', aBuy.txHash, aBuy.size, 'tokens');
  evidence.leaderBuy = aBuy;

  const trade = await until('watcher to register A as leader', async () => trades.openFor(A.userId, 'nadfun', token));
  console.log('leader trade', trade.id, 'marginFraction', trade.marginFraction.toFixed(4));
  evidence.leaderTrade = trade;

  const settled = await until('mirrors to settle', async () => {
    const ms = mirrors.forTrade(trade.id);
    return ms.length === 2 && ms.every((m) => !['pending', 'submitting'].includes(m.status)) ? ms : null;
  });
  evidence.mirrorsAfterOpen = settled;

  for (const [u, policy, free] of [[B, POLICY_B, freeB], [C, POLICY_C, freeC]] as const) {
    const m = settled.find((x) => x.userId === u.userId)!;
    if (m.status !== 'open') {
      problems.push(`${u.name} mirror is ${m.status}: ${m.error}`);
      continue;
    }
    // On-chain truth: the wallet now holds exactly what the engine says it bought,
    // and the router emitted a Buy for it from this wallet.
    const bal = await tokenBalance(token, u.address);
    const rcpt = await rpc().getTransactionReceipt(m.openTx!);
    const buyLog = rcpt?.logs.map((l) => (l.address.toLowerCase() === NADFUN.router.toLowerCase() ? routerAbi.parseLog(l) : null)).find((e) => e?.name === 'Buy');
    const spentMon = buyLog ? Number(ethers.formatEther(buyLog.args[2])) : NaN;
    const expected = mirrorNotional({ leaderMarginFraction: trade.marginFraction, leaderLeverage: 1, marketMaxLeverage: 1, followerFreeBalanceUsd: free, policy }, 0);
    const expectedMon = expected.notionalUsd / monPx;
    const row = { mirror: m.id, tokens: ethers.formatEther(bal), spentMon, expectedMon, caps: m.capApplied, buyer: buyLog?.args[0], openTx: m.openTx };
    console.log(u.name, 'mirror on-chain:', row);
    evidence[`mirror${u.name}`] = row;
    if (bal.toString() !== m.size) problems.push(`${u.name} on-chain balance ${bal} != mirror size ${m.size}`);
    if (!buyLog || (buyLog.args[0] as string).toLowerCase() !== u.address.toLowerCase()) problems.push(`${u.name} router Buy not from their wallet`);
    if (Math.abs(spentMon - expectedMon) > expectedMon * 0.02 + 1e-9) problems.push(`${u.name} spent ${spentMon} MON, expected ~${expectedMon}`);
  }
  if (!settled.find((m) => m.userId === C.userId)?.capApplied?.includes('balance_percent_cap')) problems.push('C should have been clamped by balancePercentCap');
  if (settled.find((m) => m.userId === B.userId)?.capApplied?.includes('balance_percent_cap')) problems.push('B should not have been clamped');

  // Leader exits -> followers exit.
  await sleep(3000);
  const aSell = await venue('nadfun').close({ userId: A.userId, market: token });
  console.log('A sell', aSell.txHash);
  evidence.leaderSell = aSell;
  for (const u of [B, C]) {
    await until(`${u.name} sold out (on-chain balance 0)`, async () => (await tokenBalance(token, u.address)) === 0n);
    console.log(u.name, 'sold out, on-chain balance 0');
  }
  // The engine records each close after the sale's receipt; wait for that, not just the balances.
  const after = await until('engine to record both mirror closes', async () => {
    const ms = mirrors.forTrade(trade.id);
    return ms.every((m) => m.status === 'closed') ? ms : null;
  }, 60_000).catch(() => mirrors.forTrade(trade.id));
  evidence.mirrorsAfterClose = after;
  for (const m of after) if (m.status !== 'closed') problems.push(`mirror ${m.id} is ${m.status} after leader exit`);
  if (!trades.get(trade.id)!.closedAt) problems.push('leader trade not marked closed');

  // No mirror became a leader of its own (the engine tags its txs before sending).
  const extra = [B, C].map((u) => trades.openFor(u.userId, 'nadfun', token)).filter(Boolean);
  if (extra.length) problems.push('a follower mirror was picked up as a new leader trade');
  evidence.followerLeaderTrades = extra.length;

  if (problems.length) throw new Error('GATE FAILED: ' + problems.join('; '));
  console.log('\nGATE OK (Nad.fun half)');
  evidence.result = 'pass';
} catch (e) {
  evidence.result = 'fail';
  evidence.error = String(e);
  evidence.problems = problems;
  console.error(e);
  process.exitCode = 1;
} finally {
  engine?.stop();
  for (const u of users) evidence[`sweep${u.name}`] = await sweepBack(u.signer).catch((e) => String(e));
  mkdirSync('data/evidence', { recursive: true });
  const file = `data/evidence/phase4-nadfun-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(json(evidence), null, 2));
  console.log('evidence ->', file);
  process.exit(process.exitCode ?? 0);
}
