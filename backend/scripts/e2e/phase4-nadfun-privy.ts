// Phase 4, Nad.fun half, on the production signing path.
//   A (leader) = a plain wallet trading on its own, like a user on nad.fun's UI.
//   B, C (followers) = real Privy wallets owned by member keys. The backend
//     signer is attached the way the frontend does it: memberSignerGrant()
//     issues the per-member policy, the member adds our key quorum under it.
//   The engine uses signerFor() with NO test overrides for B and C, so every
//   mirror is signed by Privy under that member's policy and broadcast by us.
// Then A sells half (mirrors sell half of themselves, straight away), A buys
// more (mirrors add the same share after the skip window), and A exits.
// Also checks backendSignerStatus() against Privy, and that lowering a cap
// marks the attached policy as outdated (it must never keep the bigger one).
import '../../src/config/env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { generateP256KeyPair } from '@privy-io/node';
import { rpc } from '../../src/chain/signer.js';
import { MirrorEngine } from '../../src/mirror/engine.js';
import { adjustments, mirrors, trades } from '../../src/mirror/repo.js';
import { NadWatcher } from '../../src/nadfun/watcher.js';
import { listMonMarkets, quoteBuy, tokenBalance, buy as nadBuy, sell as nadSell } from '../../src/nadfun/trading.js';
import { backendSignerStatus, forgetSignerStatus, memberSignerGrant, privy, PrivyPolicySigner } from '../../src/privy/policy.js';
import { clans, type MirrorPolicy } from '../../src/store/clans.js';
import { members } from '../../src/store/members.js';
import { funder, newThrowaway, sweepBack } from './fund.js';

const FUND_EACH = ethers.parseEther(process.env.NAD_E2E_MON_EACH ?? '0.8');
const LEADER_BUY = ethers.parseEther(process.env.NAD_E2E_LEADER_BUY_MON ?? '0.1');
const LEADER_ADD = ethers.parseEther(process.env.NAD_E2E_LEADER_ADD_MON ?? '0.05');
const POLICY_B: MirrorPolicy = { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 };
const POLICY_C: MirrorPolicy = { enabled: true, balancePercentCap: 5, maxUsdPerTrade: 1000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };
const problems: string[] = [];
const owners: PrivyPolicySigner[] = [];
let leader: ReturnType<typeof newThrowaway> | undefined;
let engine: MirrorEngine | undefined;

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 150_000): Promise<T> {
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
  const p = privy();

  // Leader: a plain wallet.
  leader = newThrowaway('phase4-privy-A');
  const A = { userId: `e2e-privy:A:${leader.address.toLowerCase()}`, address: leader.address };
  members.upsert(A.userId, A.address);
  evidence.seedA = await f.sendTransaction({ to: A.address, data: '0x', value: FUND_EACH });

  const clan = clans.create(`e2e-privy-${Date.now()}`, A.userId, { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });

  // Followers: real Privy wallets, backend signer attached under each member's policy.
  const followers: { name: string; userId: string; address: string; policy: MirrorPolicy }[] = [];
  for (const [name, policy] of [['B', POLICY_B], ['C', POLICY_C]] as const) {
    const key = await generateP256KeyPair();
    const w = await p.wallets().create({ chain_type: 'ethereum', owner: { public_key: key.publicKey } });
    const userId = `e2e-privy:${name}:${w.address.toLowerCase()}`;
    members.upsert(userId, w.address, w.id);
    clans.join(clan.id, userId, policy);
    const grant = await memberSignerGrant(userId, w.address, policy.maxUsdPerTrade);
    await p.wallets().update(w.id, {
      additional_signers: [{ signer_id: grant.signerId, override_policy_ids: grant.policyIds }],
      authorization_context: { authorization_private_keys: [key.privateKey] },
    } as never); // what the frontend's addSigners() does
    forgetSignerStatus(userId);
    const st = await backendSignerStatus(userId);
    if (!st.attached || !st.policyCurrent) problems.push(`${name}: signer status after attach ${JSON.stringify(st)}`);
    owners.push(new PrivyPolicySigner(w.id, w.address, key.privateKey));
    evidence[`seed${name}`] = await f.sendTransaction({ to: w.address, data: '0x', value: FUND_EACH });
    followers.push({ name, userId, address: w.address, policy });
    evidence[`wallet${name}`] = { address: w.address, walletId: w.id, grant, signerStatus: st };
    console.log(name, w.address, 'grant', grant.policyIds[0], 'signer', JSON.stringify(st));
  }
  const [B, C] = followers as [(typeof followers)[0], (typeof followers)[0]];

  engine = new MirrorEngine({ optOutSeconds: 4, minMirrorAusd: 0.00001 }, { sessionFor: async () => { throw new Error('no perpl'); }, nadWatcher: new NadWatcher(1000) });
  await engine.start();

  let token = '';
  for (const m of await listMonMarkets('latest_trade', 100)) {
    if (!m.graduated && (await quoteBuy(m.token, ethers.parseEther('0.01')).catch(() => 0n)) > 0n) { token = m.token.toLowerCase(); break; }
  }
  if (!token) throw new Error('no MON-quoted curve token');
  evidence.token = token;

  // A trades on its own.
  const aBuy = await nadBuy(leader, token, LEADER_BUY);
  console.log('A buy', aBuy.txHash);
  evidence.leaderBuy = json(aBuy);
  const trade = await until('watcher to register A', async () => trades.openFor(A.userId, 'nadfun', token));
  const settled = await until('mirrors to settle', async () => {
    const ms = mirrors.forTrade(trade.id);
    return ms.length === 2 && ms.every((m) => !['pending', 'submitting'].includes(m.status)) ? ms : null;
  });
  for (const u of [B, C]) {
    const m = settled.find((x) => x.userId === u.userId)!;
    const bal = await tokenBalance(token, u.address);
    console.log(u.name, 'mirror', m.status, m.openTx, 'tokens', ethers.formatEther(bal), 'caps', m.capApplied, m.error ?? '');
    evidence[`mirror${u.name}`] = json({ mirror: m, balance: bal });
    if (m.status !== 'open') problems.push(`${u.name} mirror ${m.status}: ${m.error}`);
    else if (bal.toString() !== m.size) problems.push(`${u.name} balance ${bal} != mirror size ${m.size}`);
  }
  if (!settled.find((m) => m.userId === C.userId)?.capApplied?.includes('balance_percent_cap')) problems.push('C should be clamped by balancePercentCap');

  // A sells half: each mirror sells half of itself, no window.
  await sleep(3000);
  const aHeld = await tokenBalance(token, A.address);
  const aHalf = await nadSell(leader, token, aHeld / 2n);
  console.log('A sells half', aHalf.txHash);
  evidence.leaderHalfSell = json(aHalf);
  const reduced = await until('mirrors to follow the half sell', async () => {
    const as = settled.flatMap((m) => adjustments.forMirror(m.id)).filter((a) => a.kind === 'reduce');
    return as.length === 2 && as.every((a) => !['pending', 'submitting'].includes(a.status)) ? as : null;
  });
  for (const u of [B, C]) {
    const m = mirrors.forTrade(trade.id).find((x) => x.userId === u.userId)!;
    const a = reduced.find((x) => x.userId === u.userId)!;
    const before = BigInt(settled.find((x) => x.userId === u.userId)!.size!);
    const bal = await tokenBalance(token, u.address);
    console.log(u.name, 'reduce', a.status, a.tx, 'sold', a.sizeDelta, 'of', before, 'now holds', bal, a.error ?? '');
    evidence[`reduce${u.name}`] = json({ adjustment: a, balance: bal });
    if (a.status !== 'done') problems.push(`${u.name} reduce ${a.status}: ${a.error}`);
    else if (bal.toString() !== m.size) problems.push(`${u.name} holds ${bal} but the mirror says ${m.size}`);
    else if (Math.abs(Number(BigInt(a.sizeDelta!) * 1000n / before) - 500) > 5) problems.push(`${u.name} sold ${a.sizeDelta} of ${before}, not about half`);
  }

  // A buys more: each mirror adds the same share of itself after the skip window.
  const aAdd = await nadBuy(leader, token, LEADER_ADD);
  console.log('A adds', aAdd.txHash);
  evidence.leaderAdd = json(aAdd);
  const added = await until('mirrors to follow the add', async () => {
    const as = settled.flatMap((m) => adjustments.forMirror(m.id)).filter((a) => a.kind === 'add');
    return as.length === 2 && as.every((a) => !['pending', 'submitting'].includes(a.status)) ? as : null;
  });
  const leaderRatio = added[0]!.ratio;
  for (const u of [B, C]) {
    const m = mirrors.forTrade(trade.id).find((x) => x.userId === u.userId)!;
    const a = added.find((x) => x.userId === u.userId)!;
    const bal = await tokenBalance(token, u.address);
    console.log(u.name, 'add', a.status, a.tx, 'ratio', a.ratio.toFixed(3), 'bought', a.sizeDelta, 'now holds', bal, a.error ?? '');
    evidence[`add${u.name}`] = json({ adjustment: a, balance: bal });
    if (a.status !== 'done') problems.push(`${u.name} add ${a.status}: ${a.error}`);
    else if (bal.toString() !== m.size) problems.push(`${u.name} holds ${bal} but the mirror says ${m.size}`);
  }
  console.log('leader size ratio for the add', leaderRatio.toFixed(3));

  await sleep(3000);
  const aSell = await nadSell(leader, token);
  console.log('A sell', aSell.txHash);
  evidence.leaderSell = json(aSell);
  const closed = await until('both mirrors closed', async () => {
    const ms = mirrors.forTrade(trade.id);
    return ms.every((m) => m.status === 'closed') ? ms : null;
  });
  for (const u of [B, C]) {
    const bal = await tokenBalance(token, u.address);
    if (bal !== 0n) problems.push(`${u.name} still holds ${bal}`);
  }
  evidence.mirrorsAfterClose = closed;
  console.log('closes', closed.map((m) => m.closeTx).join(' '));

  // Lowering a cap must retire the attached (bigger) policy.
  await memberSignerGrant(B.userId, B.address, 5);
  forgetSignerStatus(B.userId);
  const afterLower = await backendSignerStatus(B.userId);
  evidence.afterLoweringCap = afterLower;
  if (afterLower.policyCurrent) problems.push('lowering the cap left the old policy current');
  else console.log('OK   lowering B\'s cap made the attached policy outdated until re-approved:', JSON.stringify(afterLower));

  if (problems.length) throw new Error('GATE FAILED: ' + problems.join('; '));
  console.log('\nGATE OK (Nad.fun half, production Privy signing)');
  evidence.result = 'pass';
} catch (e) {
  evidence.result = 'fail';
  evidence.error = String(e);
  evidence.problems = problems;
  console.error(e);
  process.exitCode = 1;
} finally {
  engine?.stop();
  const fAddr = funder().address;
  if (leader) evidence.sweepA = await sweepBack(leader).catch((e) => String(e));
  for (const o of owners) {
    try {
      const bal = await rpc().getBalance(o.address);
      const reserve = 21_000n * ((await rpc().getFeeData()).maxFeePerGas ?? ethers.parseUnits('250', 'gwei')) * 3n;
      if (bal > reserve * 2n) evidence[`sweep_${o.address}`] = await o.sendTransaction({ to: fAddr, data: '0x', value: bal - reserve });
    } catch (e) {
      evidence[`sweepError_${o.address}`] = String(e);
    }
  }
  mkdirSync('data/evidence', { recursive: true });
  const file = `data/evidence/phase4-nadfun-privy-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(json(evidence), null, 2));
  console.log('evidence ->', file);
  process.exit(process.exitCode ?? 0);
}
