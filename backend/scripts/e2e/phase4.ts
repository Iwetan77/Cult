// Phase 4 gate (both venues): 3 fresh testnet wallets in one clan.
//   Perpl:   A opens a position -> B and C get mirrored positions within their
//            caps (read from Perpl's /v1/trading/positions) -> A closes -> B, C flat.
//   Nad.fun: A buys a MON-quoted token -> B and C get mirror buys within their
//            caps (read as on-chain token balances) -> A sells all -> B, C sold.
// Truth always comes from the venue, never our DB. Needs the funder wallet to
// hold MON and Perpl's testnet AUSD. Signers here are raw test keys registered
// as overrides; in production the same engine signs through Privy's policy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { onboardMember, restFor, sessionFor, stopAllSessions } from '../../src/accounts/lifecycle.js';
import { registerSigner } from '../../src/accounts/signers.js';
import { rpc } from '../../src/chain/signer.js';
import { MirrorEngine } from '../../src/mirror/engine.js';
import { mirrors, trades } from '../../src/mirror/repo.js';
import { NadWatcher } from '../../src/nadfun/watcher.js';
import { listMonMarkets, quoteBuy, tokenBalance } from '../../src/nadfun/trading.js';
import { getExchangeInfo, getMarketBySymbol } from '../../src/perpl/context.js';
import { clans, type MirrorPolicy } from '../../src/store/clans.js';
import { members } from '../../src/store/members.js';
import { venue } from '../../src/venues/index.js';
import { freshFundedWallet, preflight } from './fund.js';

const OPT_OUT = Number(process.env.E2E_OPT_OUT_SECONDS ?? '5');
const POLICY_B: MirrorPolicy = { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 };
const POLICY_C: MirrorPolicy = { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 15 }; // tight: must clamp
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };
const problems: string[] = [];
let engine: MirrorEngine | undefined;
const json = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  throw new Error(`timed out: ${what}`);
}

async function settled(tradeId: string) {
  return until('mirrors to settle', async () => {
    const ms = mirrors.forTrade(tradeId);
    return ms.length === 2 && ms.every((m) => !['pending', 'submitting'].includes(m.status)) ? ms : null;
  }, OPT_OUT * 1000 + 90_000);
}

try {
  const { minAccountOpen } = await getExchangeInfo();
  const deposit = minAccountOpen + 10_000_000n;
  await preflight(3, deposit);

  const users: { name: string; userId: string; accountId: number; address: string }[] = [];
  for (const name of ['A', 'B', 'C']) {
    const { signer, txs } = await freshFundedWallet(deposit);
    const userId = `e2e:${name}:${signer.address.toLowerCase()}`;
    const ob = await onboardMember(userId, signer, { initialDeposit: deposit });
    registerSigner(userId, signer);
    users.push({ name, userId, accountId: ob.accountId, address: signer.address });
    evidence[`onboard${name}`] = { address: signer.address, accountId: ob.accountId, fundTxs: txs, txs: ob.txs };
    console.log(name, signer.address, 'perpl acct', ob.accountId);
  }
  const [A, B, C] = users as [(typeof users)[0], (typeof users)[0], (typeof users)[0]];
  const clan = clans.create(`e2e-${Date.now()}`, A.userId, { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  clans.join(clan.id, B.userId, POLICY_B);
  clans.join(clan.id, C.userId, POLICY_C);

  engine = new MirrorEngine({ optOutSeconds: OPT_OUT, minMirrorAusd: 0.5 }, { sessionFor, nadWatcher: new NadWatcher(1000) });
  await engine.start();

  // ---------------- Perpl ----------------
  const btc = await getMarketBySymbol(process.env.E2E_MARKET ?? 'BTC');
  const perplOpen = await venue('perpl').open({ userId: A.userId, market: String(btc.id), side: 'long', notionalAusd: 60, leverage: 3 });
  console.log('A perpl open', perplOpen);
  const pTrade = await until('perpl leader trade', async () => trades.openFor(A.userId, 'perpl', String(btc.id)));
  const pMirrors = await settled(pTrade.id);
  for (const [u, policy] of [[B, POLICY_B], [C, POLICY_C]] as const) {
    const m = pMirrors.find((x) => x.userId === u.userId)!;
    if (m.status !== 'open') { problems.push(`perpl ${u.name} mirror ${m.status}: ${m.error}`); continue; }
    const pos = (await restFor(u.userId).positions()).d.find((p) => p.mkt === btc.id);
    if (!pos) { problems.push(`perpl ${u.name}: Perpl shows no position`); continue; }
    const h = (await venue('perpl').holdings(u.userId, [String(btc.id)]))[0]!;
    evidence[`perplMirror${u.name}`] = json({ mirror: m, position: pos, holding: h });
    if (h.side !== 'long') problems.push(`perpl ${u.name} side ${h.side}`);
    if (h.valueAusd > policy.maxUsdPerTrade * 1.03) problems.push(`perpl ${u.name} notional ${h.valueAusd} over cap ${policy.maxUsdPerTrade}`);
  }
  if (!pMirrors.find((m) => m.userId === C.userId)?.capApplied?.includes('max_usd_per_trade')) problems.push('perpl C should have hit max_usd_per_trade');
  await sleep(3000);
  evidence.perplLeaderClose = await venue('perpl').close({ userId: A.userId, market: String(btc.id) });
  for (const u of [B, C]) {
    await until(`perpl ${u.name} flat`, async () => !(await restFor(u.userId).positions()).d.some((p) => p.mkt === btc.id));
  }
  evidence.perplMirrorsAfterClose = mirrors.forTrade(pTrade.id);
  console.log('perpl: followers flat after leader close (read from Perpl)');

  // ---------------- Nad.fun ----------------
  let token = '';
  for (const m of await listMonMarkets('latest_trade', 100)) {
    if ((await quoteBuy(m.token, ethers.parseEther('0.01')).catch(() => 0n)) > 0n) { token = m.token.toLowerCase(); break; }
  }
  if (!token) throw new Error('no MON-quoted Nad.fun token quoting a buy');
  const balBefore = { B: await tokenBalance(token, B.address), C: await tokenBalance(token, C.address) };
  // A buys on their own. Signed by A's key, not tagged: the watcher must see it as a leader trade.
  const aBuy = await venue('nadfun').open({ userId: A.userId, market: token, side: 'buy', notionalAusd: 0.5 });
  console.log('A nad.fun buy', aBuy.txHash);
  const nTrade = await until('nadfun leader trade', async () => trades.openFor(A.userId, 'nadfun', token), 60_000);
  const nMirrors = await settled(nTrade.id);
  for (const [u, policy] of [[B, POLICY_B], [C, POLICY_C]] as const) {
    const m = nMirrors.find((x) => x.userId === u.userId)!;
    const bal = await tokenBalance(token, u.address);
    evidence[`nadMirror${u.name}`] = json({ mirror: m, balance: bal });
    if (m.status !== 'open') { problems.push(`nadfun ${u.name} mirror ${m.status}: ${m.error}`); continue; }
    if (bal - balBefore[u.name as 'B' | 'C'] !== BigInt(m.size!)) problems.push(`nadfun ${u.name} on-chain balance change != mirror size`);
    if ((m.notionalUsd ?? 0) > policy.maxUsdPerTrade * 1.03) problems.push(`nadfun ${u.name} spent ${m.notionalUsd} over cap`);
  }
  await sleep(3000);
  evidence.nadLeaderSell = await venue('nadfun').close({ userId: A.userId, market: token });
  for (const u of [B, C]) {
    await until(`nadfun ${u.name} sold`, async () => (await tokenBalance(token, u.address)) === balBefore[u.name as 'B' | 'C']);
  }
  evidence.nadMirrorsAfterClose = mirrors.forTrade(nTrade.id);
  console.log('nad.fun: followers sold after leader sold (read from chain)');

  evidence.gasLeft = Object.fromEntries(await Promise.all(users.map(async (u) => [u.name, ethers.formatEther(await rpc().getBalance(u.address))])));
  if (problems.length) throw new Error('GATE FAILED: ' + problems.join('; '));
  console.log('\nGATE OK');
  evidence.result = 'pass';
} catch (e) {
  evidence.result = 'fail';
  evidence.error = String(e);
  evidence.problems = problems;
  console.error(e);
  process.exitCode = 1;
} finally {
  engine?.stop();
  stopAllSessions();
  mkdirSync('data/evidence', { recursive: true });
  const file = `data/evidence/phase4-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(json(evidence), null, 2));
  console.log('evidence ->', file);
  void members;
}
