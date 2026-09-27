// Ranking rules with a fake indexer: own trades only, PnL then win rate,
// unranked members still see themselves, private cults never on the cults board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

const W = (n: number) => '0x' + String(n).padStart(40, '0');
// wallet -> perpl round trips (pnl $, win) ; nad.fun none. W(5) has a copied trade only.
const trades: Record<string, { openTx: string; realizedPnlUsd: string; isWin: boolean; closedAt: string }[]> = {
  [W(1)]: [{ openTx: '0xa1', realizedPnlUsd: '50', isWin: true, closedAt: '1' }],
  [W(2)]: [{ openTx: '0xa2', realizedPnlUsd: '120', isWin: true, closedAt: '1' }, { openTx: '0xa3', realizedPnlUsd: '-20', isWin: false, closedAt: '2' }],
  [W(3)]: [{ openTx: '0xa4', realizedPnlUsd: '100', isWin: true, closedAt: '1' }],
  [W(4)]: [{ openTx: '0xa5', realizedPnlUsd: '100', isWin: true, closedAt: '1' }, { openTx: '0xa6', realizedPnlUsd: '0', isWin: false, closedAt: '2' }],
  [W(5)]: [{ openTx: '0xcopied', realizedPnlUsd: '999', isWin: true, closedAt: '1' }],
};
const srv = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const ids: string[] = JSON.parse(b).variables.ids;
    const Trader = ids.filter((id) => trades[id] || id === W(6)).map((id) => ({ id, trades: trades[id] ?? [], nadFunTrades: [] }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { Trader } }));
  });
});
await new Promise<void>((ok) => srv.listen(0, ok));
process.env.INDEXER_GRAPHQL_URL = `http://127.0.0.1:${(srv.address() as any).port}/v1/graphql`;
after(() => srv.close());

let lb: typeof import('../src/api/leaderboards.js');
let clans: typeof import('../src/store/clans.js')['clans'];
let pub = '';
let priv = '';

before(async () => {
  lb = await import('../src/api/leaderboards.js');
  ({ clans } = await import('../src/store/clans.js'));
  const { members } = await import('../src/store/members.js');
  const { recordEngineTx } = await import('../src/mirror/origin.js');
  for (let i = 1; i <= 6; i++) members.upsert(`u${i}`, W(i));
  members.setCountry('u1', 'NG');
  members.setCountry('u2', 'NG');
  members.setCountry('u3', 'GB');
  recordEngineTx('0xcopied', W(5), 'mirror_open', 'm1'); // u5's only trade was a copy
  const p = { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 50 };
  pub = clans.create('pub', 'u1', p, 'public').id;
  clans.join(pub, 'u2', p);
  priv = clans.create('priv', 'u3', p).id;
  clans.join(priv, 'u4', p);
});

test('global: PnL first, then win rate; copies and traderless members unranked', async () => {
  const b = await lb.globalBoard('u6');
  assert.deepEqual(b.entries.map((e) => [e.rank, e.memberId]), [[1, 'u3'], [2, 'u2'], [3, 'u4'], [4, 'u1']]);
  // u3, u2 and u4 are all +$100: u3 first on win rate (1/1 vs 1/2); u2 and u4 tie on everything and keep join order.
  assert.equal(b.rankedCount, 4);
  assert.equal(b.memberCount, 6);
  assert.equal(b.me?.rank, null, 'u6 is verified but has no closed trade: no rank, still sees themself');
  const u5 = (await lb.globalBoard('u5')).me!;
  assert.equal(u5.rank, null, "u5's only trade was a copy: not theirs");
  assert.equal(u5.copiedTradeCount, 1);
});

test('country board only has members who picked it', async () => {
  const ng = await lb.countryBoard('ng', 'u1');
  assert.equal(ng.name, 'Nigeria');
  assert.deepEqual(ng.entries.map((e) => e.memberId), ['u2', 'u1']);
  assert.equal(ng.me?.rank, 2);
  await assert.rejects(() => lb.countryBoard('EU', 'u1'), /isn't a country/);
});

test('cult board and the public cults board', async () => {
  const c = await lb.cultBoard(clans.get(priv)!, 'u3');
  assert.deepEqual(c.entries.map((e) => e.memberId), ['u3', 'u4']);
  const all = await lb.cultsBoard('u1');
  assert.deepEqual(all.entries.map((e) => e.cultId), [pub], 'private cults never listed');
  assert.equal(all.entries[0]!.realizedPnlUsd, 150);
  assert.equal(all.entries[0]!.joined, true);
  assert.equal(all.entries[0]!.winRate, 2 / 3);
});
