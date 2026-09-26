// Phase 4 gate: 3 fresh testnet accounts in one clan. A opens a position; B and
// C must get mirrored positions sized from their own balance and within their
// caps, verified by reading Perpl's /v1/trading/positions for each (not our DB).
// Then A closes and B/C must be flat on that market, again read from Perpl.
import { mkdirSync, writeFileSync } from 'node:fs';
import { onboardMember, restFor, sessionFor, stopAllSessions } from '../../src/accounts/lifecycle.js';
import { MirrorEngine } from '../../src/mirror/engine.js';
import { mirrors, trades } from '../../src/mirror/repo.js';
import { sizeMirror } from '../../src/mirror/sizing.js';
import { getExchangeInfo, getMarketBySymbol, getTicker, maxLeverageHundredths, scale } from '../../src/perpl/context.js';
import { PositionSide } from '../../src/perpl/types.js';
import { clans, type MirrorPolicy } from '../../src/store/clans.js';
import { closePosition, openPosition, sizeForMargin } from '../../src/trading/positions.js';
import { freshFundedWallet, preflight } from './fund.js';

const SYMBOL = process.env.E2E_MARKET ?? 'BTC';
const OPT_OUT_SECONDS = Number(process.env.E2E_OPT_OUT_SECONDS ?? '5');
const LEADER_MARGIN_USD = 20;
const LEADER_LEVERAGE = 3;
// B: generous caps, should mirror proportionally. C: tight notional cap, should be clamped.
const POLICY_B: MirrorPolicy = { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 };
const POLICY_C: MirrorPolicy = { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 15 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };
const problems: string[] = [];
let engine: MirrorEngine | undefined;

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  throw new Error(`timed out: ${what}`);
}

try {
  const { minAccountOpen, collateralDecimals } = await getExchangeInfo();
  const deposit = minAccountOpen + 10_000_000n;
  await preflight(3, deposit);

  const users: { name: string; userId: string; accountId: number; address: string }[] = [];
  for (const name of ['A', 'B', 'C']) {
    const { signer, txs } = await freshFundedWallet(deposit);
    const userId = `e2e:${name}:${signer.address.toLowerCase()}`;
    const ob = await onboardMember(userId, signer, { initialDeposit: deposit });
    console.log(name, signer.address, 'acct', ob.accountId, ob.txs);
    users.push({ name, userId, accountId: ob.accountId, address: signer.address });
    evidence[`onboard${name}`] = { address: signer.address, accountId: ob.accountId, fundTxs: txs, txs: ob.txs };
  }
  const [A, B, C] = users;

  const clan = clans.create(`e2e-${Date.now()}`, A.userId, { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  clans.join(clan.id, B.userId, POLICY_B);
  clans.join(clan.id, C.userId, POLICY_C);
  evidence.clan = { id: clan.id, policies: { B: POLICY_B, C: POLICY_C } };

  engine = new MirrorEngine({ optOutSeconds: OPT_OUT_SECONDS }, sessionFor);
  await engine.start();

  // Snapshot follower free balances before anything moves, for expected sizing.
  const unit = 10 ** collateralDecimals;
  const freeBefore: Record<string, number> = {};
  for (const u of [B, C]) {
    const w = await restFor(u.userId).wallet();
    const a = w.as!.find((x) => x.id === u.accountId)!;
    freeBefore[u.name] = (Number(a.b) - Number(a.lb)) / unit;
  }

  // A trades on their own. Not tagged as an engine order, so it's a leader trade.
  const market = await getMarketBySymbol(SYMBOL);
  const sessionA = await sessionFor(A.userId);
  const size = await sizeForMargin(market.id, LEADER_MARGIN_USD, LEADER_LEVERAGE);
  const leaderOpen = await openPosition(sessionA, { accountId: A.accountId, marketId: market.id, side: 'long', size, leverage: LEADER_LEVERAGE });
  console.log('A opened', { oid: leaderOpen.oid, fs: leaderOpen.fs, tx: leaderOpen.at?.txid });
  evidence.leaderOpen = leaderOpen;

  const trade = await until('engine to register A as leader', async () => trades.openFor(A.accountId, market.id));
  evidence.leaderTrade = trade;

  // Mirrors fire after the opt-out window; wait for both to leave pending/submitting.
  const settled = await until(
    'mirrors to settle',
    async () => {
      const ms = mirrors.forTrade(trade.id);
      return ms.length === 2 && ms.every((m) => !['pending', 'submitting'].includes(m.status)) ? ms : null;
    },
    OPT_OUT_SECONDS * 1000 + 60_000,
  );
  evidence.mirrorsAfterOpen = settled;

  const { d: ticker } = await getTicker();
  const mark = scale.unprice(ticker[String(market.id)]!.mrk, market);
  for (const [u, policy] of [
    [B, POLICY_B],
    [C, POLICY_C],
  ] as const) {
    const m = settled.find((x) => x.userId === u.userId)!;
    if (m.status !== 'open') {
      problems.push(`${u.name} mirror is ${m.status}: ${m.error}`);
      continue;
    }
    // Truth comes from Perpl, not our DB.
    const pos = (await restFor(u.userId).positions()).d.find((p) => p.mkt === market.id);
    if (!pos) {
      problems.push(`${u.name}: Perpl shows no ${SYMBOL} position`);
      continue;
    }
    const side = pos.sd === PositionSide.Long ? 'long' : 'short';
    const perplSize = scale.unsize(pos.s, market);
    const perplNotional = perplSize * mark;
    const expected = sizeMirror({
      leaderMarginFraction: trade.marginFraction,
      leaderLeverage: trade.leverage / 100,
      marketMaxLeverage: maxLeverageHundredths(market) / 100,
      followerFreeBalanceUsd: freeBefore[u.name]!,
      markPrice: mark,
      sizeDecimals: market.config.size_decimals,
      policy,
    });
    const row = { side, perplSize, perplNotional, expectedSize: expected.size, caps: m.capApplied, cap: policy.maxUsdPerTrade };
    console.log(u.name, 'mirror on Perpl:', row);
    evidence[`mirror${u.name}`] = { ...row, position: pos, mirror: m };

    if (side !== trade.side) problems.push(`${u.name} side ${side} != leader ${trade.side}`);
    // Mark moves between sizing and now; allow 3% plus one size step.
    const tol = expected.size * 0.03 + 10 ** -market.config.size_decimals;
    if (Math.abs(perplSize - expected.size) > tol) problems.push(`${u.name} size ${perplSize} vs expected ${expected.size}`);
    if (perplNotional > policy.maxUsdPerTrade * 1.03) problems.push(`${u.name} notional ${perplNotional} over cap ${policy.maxUsdPerTrade}`);
  }
  if (!settled.find((m) => m.userId === C.userId)?.capApplied?.includes('max_usd_per_trade')) {
    problems.push('C was supposed to hit max_usd_per_trade and did not');
  }

  // Leader exits -> followers exit.
  await sleep(3000);
  const leaderClose = await closePosition(sessionA, A.accountId, market.id);
  console.log('A closed', { oid: leaderClose.oid, tx: leaderClose.at?.txid });
  evidence.leaderClose = leaderClose;

  for (const u of [B, C]) {
    await until(`${u.name} flat on ${SYMBOL} per Perpl`, async () => {
      const ps = (await restFor(u.userId).positions()).d;
      return !ps.some((p) => p.mkt === market.id);
    });
    console.log(u.name, `flat on ${SYMBOL} (read from Perpl /v1/trading/positions)`);
  }
  evidence.mirrorsAfterClose = mirrors.forTrade(trade.id);
  for (const u of [B, C]) {
    const hist = await restFor(u.userId).positionHistory(10);
    evidence[`positionHistory${u.name}`] = hist.d.slice(0, 4);
  }

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
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log('evidence ->', file);
}
