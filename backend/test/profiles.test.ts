// Records, profiles and the home feed with a fake indexer: streaks, average
// win, own-only top trades, "traders were in", 7-day summary.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

const W = (n: number) => '0x' + String(n).padStart(40, '0');
const now = Date.now();
const day = 86_400_000;
const perp = (openTx: string, entry: number, exit: number, side: string, pnl: number, closedAt: number) =>
  ({ openTx, realizedPnlUsd: String(pnl), isWin: pnl > 0, closedAt: String(closedAt), openedAt: String(closedAt - 1000), marketId: '16', symbol: 'BTC-PERP', side, entryPrice: String(entry), exitPrice: String(exit) });
const meme = (openTx: string, cost: number, proceeds: number, closedAt: number) =>
  ({ openTx, realizedPnlMon: String(proceeds - cost), isWin: proceeds > cost, closedAt: String(closedAt), openedAt: String(closedAt - 1000), token: '0x' + 'ab'.repeat(20), costMon: String(cost), proceedsMon: String(proceeds) });
const data: Record<string, { trades: any[]; nadFunTrades: any[] }> = {
  // newest first by closedAt: win, win, loss -> streak 2
  [W(1)]: { trades: [perp('0xL1', 100, 110, 'LONG', 10, now - 1 * day), perp('0xL2', 100, 90, 'SHORT', 10, now - 2 * day), perp('0xL3', 100, 95, 'LONG', -5, now - 3 * day)], nadFunTrades: [] },
  // a +50% meme that was a copy (never tops the feed), and an old +300% (outside 7 days)
  [W(2)]: { trades: [], nadFunTrades: [meme('0xCOPY', 1, 1.5, now - day), meme('0xOLD', 1, 4, now - 30 * day)] },
};
const srv = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const ids: string[] = JSON.parse(b).variables.ids;
    const Trader = ids.filter((id) => data[id]).map((id) => ({ id, ...data[id] }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { Trader } }));
  });
});
await new Promise<void>((ok) => srv.listen(0, ok));
process.env.INDEXER_GRAPHQL_URL = `http://127.0.0.1:${(srv.address() as any).port}/v1/graphql`;
after(() => srv.close());

let P: typeof import('../src/api/profiles.js');
let tradeId = '';
before(async () => {
  P = await import('../src/api/profiles.js');
  const { members } = await import('../src/store/members.js');
  const { recordEngineTx } = await import('../src/mirror/origin.js');
  const { trades, mirrors } = await import('../src/mirror/repo.js');
  const { clans } = await import('../src/store/clans.js');
  for (const i of [1, 2, 3]) members.upsert(`u${i}`, W(i));
  recordEngineTx('0xCOPY', W(2), 'mirror_open', 'x');
  const clanId = clans.create('c', 'u1').id;
  clans.join(clanId, 'u2');
  clans.join(clanId, 'u3');
  // u1's +10% long was a leader trade that two members copied
  const t = trades.insert({ id: 'lt1', venue: 'perpl', userId: 'u1', accountId: 1, market: '16', side: 'long', positionId: 1, size: '1', entryPrice: 100, leverage: 500, marginFraction: 0.1, openTx: '0xL1', openedAt: now - 2 * day });
  tradeId = t.id;
  for (const u of ['u2', 'u3']) {
    const m = mirrors.insertPending({ tradeId: t.id, clanId, userId: u, skipUntil: now });
    mirrors.transition(m.id, 'pending', 'submitting');
    mirrors.transition(m.id, 'submitting', 'open');
  }
});

test('record: streak counts back from the latest close, average win is a %', async () => {
  const p = await P.profile(W(1), 'u2');
  assert.equal(p.record.tradeCount, 3);
  assert.equal(p.record.streak, 2);
  assert.equal(p.record.avgWinPct, 10, 'a +10% long and a +10% short');
  assert.equal(p.closedTrades[0]!.returnPct, 10);
  assert.equal(p.closedTrades[1]!.returnPct, 10, 'short: price down 10% is +10%');
  assert.equal(p.isMe, false);
  assert.equal((await P.profile('me', 'u1')).isMe, true);
  await assert.rejects(() => P.profile('nobody', 'u1'), /no such member/);
});

test('copied trades show on the profile, flagged, but never make the record', async () => {
  const p = await P.profile('u2', 'u2');
  assert.equal(p.record.tradeCount, 1, 'only the old meme is theirs');
  assert.ok(p.closedTrades.some((t) => t.copied && t.openTx === '0xCOPY'));
});

test('home: best own trades of the week, who was in, and my 7 days', async () => {
  const h = await P.home('u1');
  assert.deepEqual(h.topTrades.map((t) => t.returnPct), [10, 10, -5], 'the copy and the 30-day-old trade are out');
  const first = h.topTrades.find((t) => t.markerId === `trade:${tradeId}`)!;
  assert.equal(first.tradersIn, 3, 'the leader and two copies');
  assert.equal(first.symbol, 'BTC-PERP');
  assert.equal(h.sevenDay.trades, 3);
  assert.equal(h.sevenDay.profitUsd, 15);
  assert.equal(h.sevenDay.positionsOpened, 1);
});

test('recent windows: 7 and 30 days of own trades', async () => {
  const p = await P.profile(W(1), 'u1');
  assert.deepEqual(p.record.recent.d7, { tradeCount: 3, winRate: 2 / 3, realizedPnlUsd: 15 });
  const q = await P.profile(W(2), 'u2');
  assert.equal(q.record.recent.d7.tradeCount, 0, "u2's own trade is 30 days old; the week's one was a copy");
});

test('view trade: top trades link to the trade and a shared cult; the sheet has the verified result', async () => {
  const { trades } = await import('../src/mirror/repo.js');
  trades.markClosed(tradeId);
  const h = await P.home('u2');
  const card = h.topTrades.find((t) => t.tradeId === tradeId)!;
  assert.ok(card.cultId, 'u2 shares a cult with the trader, so the card opens it');
  assert.equal(card.openTx, '0xL1');
  const v = await P.tradeView(tradeId, 'u2');
  assert.equal(v.status, 'closed');
  assert.equal(v.symbol, 'BTC-PERP');
  assert.deepEqual(v.result, { returnPct: 10, pnlUsd: 10, entryPrice: 100, exitPrice: 110, isWin: true });
  assert.equal(v.tradersIn, 3);
  assert.equal(v.youCopied, true);
  assert.equal((await P.tradeView(tradeId, 'u1')).youCopied, false, 'the trader themself');
  await assert.rejects(() => P.tradeView('nope', 'u1'), /no such trade/);
});

test('app lots and older late private residuals never inherit the indexer whole-position result', async () => {
  const { trades } = await import('../src/mirror/repo.js');
  const { memberOrders } = await import('../src/mirror/member-orders.js');
  const order = memberOrders.begin({ userId: 'u1', venue: 'perpl', market: '16', kind: 'open', side: 'short',
    leverage: 500, marginFraction: 0.1, cultIds: [], markerId: null, requestedNotional: 100 });
  memberOrders.ref(order.id, { txHash: '0xL2' });
  for (const id of [order.id, 'late-private-one', 'late-private-two']) {
    trades.insert({ id, venue: 'perpl', userId: 'u1', accountId: 1, market: '16', side: 'short', positionId: null,
      netPositionId: 2, size: '1', entryPrice: 100, leverage: 500, marginFraction: 0.1,
      openTx: '0xL2', openedAt: now - 3 * day, cultIds: [] });
    trades.markClosed(id);
  }
  memberOrders.assignAllocation(order.id, 'late-private-two');
  for (const id of [order.id, 'late-private-one', 'late-private-two']) {
    const view = await P.tradeView(id, 'u2');
    assert.equal(view.result, null, 'a verified net round trip is not a verified result for each slice');
    assert.equal(view.cultId, null, 'a private entry does not reveal a shared cult');
  }
});
