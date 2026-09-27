// Phase 1 gate: fresh wallet -> funded -> Perpl account -> key enrolled ->
// real position opened -> live PnL read -> closed. Everything against
// testnet.perpl.xyz; the final checks read Perpl's own history endpoints, not
// local state. Evidence is written to data/evidence/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { onboardMember, restFor, sessionFor, stopAllSessions } from '../../src/accounts/lifecycle.js';
import { getExchangeInfo, getMarketBySymbol } from '../../src/perpl/context.js';
import { closePosition, openPosition, sizeForMargin, viewPositions } from '../../src/trading/positions.js';
import { setTpSl } from '../../src/trading/tpsl.js';
import { perplTpSl } from '../../src/venues/perpl.js';
import { freshFundedWallet, preflight } from './fund.js';

const SYMBOL = process.env.E2E_MARKET ?? 'BTC';
const MARGIN_USD = Number(process.env.E2E_MARGIN_USD ?? '10');
const LEVERAGE = Number(process.env.E2E_LEVERAGE ?? '2');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };

try {
  const { minAccountOpen } = await getExchangeInfo();
  const deposit = minAccountOpen + 10_000_000n; // min open + 10 AUSD headroom
  await preflight(1, deposit);

  const { signer, txs: fundTxs } = await freshFundedWallet(deposit);
  console.log('fresh wallet', signer.address, 'funded:', fundTxs.join(', '));
  evidence.wallet = signer.address;
  evidence.fundTxs = fundTxs;

  const userId = `e2e:${signer.address.toLowerCase()}`;
  const ob = await onboardMember(userId, signer, { initialDeposit: deposit });
  console.log('perpl account', ob.accountId, 'txs', ob.txs, 'new key', ob.enrolledNewKey);
  evidence.onboard = { accountId: ob.accountId, txs: ob.txs, apiKeyPubkey: ob.member.apiKeyPubkey };

  const session = await sessionFor(userId);
  const market = await getMarketBySymbol(SYMBOL);
  const size = await sizeForMargin(market.id, MARGIN_USD, LEVERAGE);
  console.log(`opening ${SYMBOL} long size ${size} @ ${LEVERAGE}x`);
  const open = await openPosition(session, { accountId: ob.accountId, marketId: market.id, side: 'long', size, leverage: LEVERAGE });
  console.log('open order', { rq: open.rq, oid: open.oid, st: open.st, fs: open.fs, fp: open.fp, tx: open.at?.txid });
  evidence.open = open;

  // Live PnL from Perpl's positions endpoint, priced against the live mark.
  const rest = restFor(userId);
  let views = await viewPositions((await rest.positions()).d);
  for (let i = 0; i < 10 && views.length === 0; i++) {
    await sleep(1500);
    views = await viewPositions((await rest.positions()).d);
  }
  if (views.length === 0) throw new Error('position never showed up on /v1/trading/positions');
  console.log('live position', views[0]);
  evidence.livePosition = views[0];

  // TP/SL as real Perpl trigger orders, read back from Perpl's open orders.
  const markNow = views[0].markPrice;
  const want = { takeProfit: Math.round(markNow * 1.05), stopLoss: Math.round(markNow * 0.95) };
  await setTpSl(session, ob.accountId, market.id, want);
  let got = await perplTpSl(userId, market.id);
  for (let i = 0; i < 8 && (got?.takeProfit == null || got?.stopLoss == null); i++) {
    await sleep(1500);
    got = await perplTpSl(userId, market.id);
  }
  console.log('tp/sl set', want, 'read back from Perpl', got);
  evidence.tpsl = { want, got };
  if (got?.takeProfit !== want.takeProfit || got?.stopLoss !== want.stopLoss) throw new Error(`GATE FAILED: TP/SL read back ${JSON.stringify(got)} != ${JSON.stringify(want)}`);

  await sleep(3000);
  const close = await closePosition(session, ob.accountId, market.id);
  console.log('close order', { rq: close.rq, oid: close.oid, st: close.st, fs: close.fs, fp: close.fp, tx: close.at?.txid });
  evidence.close = close;

  // Gate check: Perpl's own history shows both sides and no open position left.
  await sleep(3000);
  const [fills, orders, positionsAfter, posHistory] = await Promise.all([
    rest.fills(20),
    rest.orderHistory(20),
    rest.positions(),
    rest.positionHistory(20),
  ]);
  const openFill = fills.d.find((f) => f.oid === open.oid);
  const closeFill = fills.d.find((f) => f.oid === close.oid);
  const stillOpen = positionsAfter.d.filter((p) => p.mkt === market.id);
  evidence.history = { fills: fills.d, orders: orders.d.slice(0, 6), positionHistory: posHistory.d.slice(0, 4) };

  const problems: string[] = [];
  if (!openFill) problems.push(`open oid ${open.oid} missing from /fills`);
  if (!closeFill) problems.push(`close oid ${close.oid} missing from /fills`);
  if (stillOpen.length) problems.push(`position still open after close: ${JSON.stringify(stillOpen)}`);
  const leftover = (await rest.openOrders()).d.filter((o) => o.mkt === market.id);
  if (leftover.length) problems.push(`trigger orders left after close (should be cancelled via lp): ${leftover.map((o) => o.oid).join(',')}`);
  if (problems.length) throw new Error('GATE FAILED: ' + problems.join('; '));

  console.log('\nGATE OK. open fill tx', openFill!.at.txid, '| close fill tx', closeFill!.at.txid);
  evidence.result = 'pass';
} catch (e) {
  evidence.result = 'fail';
  evidence.error = String(e);
  console.error(e);
  process.exitCode = 1;
} finally {
  stopAllSessions();
  mkdirSync('data/evidence', { recursive: true });
  const file = `data/evidence/phase1-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log('evidence ->', file);
}
