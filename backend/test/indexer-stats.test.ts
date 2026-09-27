import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

const W1 = '0xaaaa000000000000000000000000000000000001';
const W2 = '0xaaaa000000000000000000000000000000000002';
const MIRROR_TX = '0x' + 'e1'.repeat(32);
let lastBody: any = null;
let mode: 'ok' | 'error' | 'hang' = 'ok';
const srv = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    lastBody = JSON.parse(b);
    if (mode === 'hang') return;
    if (mode === 'error') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ errors: [{ message: 'field "Trader" not found' }] }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        data: {
          Trader: [
            {
              id: W1,
              // own: perpl win +12.5, perpl loss -2.5, nad.fun win +1 MON. copied: nad.fun loss -0.5 MON (opened by our mirror tx)
              trades: [
                { openTx: '0xp1', realizedPnlUsd: '12.5', isWin: true, closedAt: '1790000000000' },
                { openTx: '0xp2', realizedPnlUsd: '-2.5', isWin: false, closedAt: '1790000100000' },
              ],
              nadFunTrades: [
                { openTx: '0xn1', realizedPnlMon: '1', isWin: true, closedAt: '1790000200000' },
                { openTx: MIRROR_TX.toUpperCase().replace('0X', '0x'), realizedPnlMon: '-0.5', isWin: false, closedAt: '1790000300000' },
              ],
            },
            { id: W2, trades: [], nadFunTrades: [] },
          ],
        },
      }),
    );
  });
});
await new Promise<void>((ok) => srv.listen(0, ok));
process.env.INDEXER_GRAPHQL_URL = `http://127.0.0.1:${(srv.address() as any).port}/v1/graphql`;
const { statsFor, toStats } = await import('../src/indexer/stats.js');

const { members } = await import('../src/store/members.js');
const { recordEngineTx } = await import('../src/mirror/origin.js');
members.upsert('did:w1', W1);
recordEngineTx(MIRROR_TX, W1, 'mirror_open', 'some-mirror');

test('one query for many wallets, lowercased; own trades only, copies apart', async () => {
  const s = await statsFor([W1.toUpperCase().replace('0X', '0x'), W2, '0xbbbb000000000000000000000000000000000003']);
  assert.deepEqual(lastBody.variables.ids, [W1, W2, '0xbbbb000000000000000000000000000000000003']);
  const a = s.get(W1)!;
  assert.equal(a.verified, true);
  assert.equal(a.tradeCount, 3, 'the mirrored round trip is not theirs');
  assert.equal(a.winRate, 2 / 3);
  assert.equal(a.realizedPnlPerplUsd, 10);
  assert.equal(a.realizedPnlMon, 1);
  assert.equal(a.lastTradeAt, 1790000200000, 'last OWN trade');
  assert.equal(a.copied.tradeCount, 1);
  assert.equal(a.copied.winRate, 0);
  const b = s.get(W2)!;
  assert.equal(b.verified, true);
  assert.equal(b.winRate, null, 'no closed trades: null, not 0%');
  const c = s.get('0xbbbb000000000000000000000000000000000003')!;
  assert.equal(c.verified, false);
  assert.equal(c.realizedPnlUsd, null);
});

test('combined $ uses the stated MON price; no price means no combined figure unless MON pnl is 0', () => {
  const row = { id: 'x', trades: [{ openTx: '0x1', realizedPnlUsd: '10', isWin: true, closedAt: 1 }], nadFunTrades: [{ openTx: '0x2', realizedPnlMon: '100', isWin: true, closedAt: 2 }] };
  const none = new Set<string>();
  const s = toStats(row, 0.03, none);
  assert.ok(Math.abs(s.realizedPnlUsd! - 13) < 1e-9);
  assert.equal(s.monPriceUsed, 0.03);
  assert.equal(toStats(row, null, none).realizedPnlUsd, null);
  assert.equal(toStats({ ...row, nadFunTrades: [] }, null, none).realizedPnlUsd, 10);
  assert.equal(toStats(row, 0.03, new Set(['0x2'])).copied.realizedPnlUsd, 3, 'copied $ uses the same price');
});

test('indexer errors degrade to unverified, never throw', async () => {
  mode = 'error';
  const s = await statsFor(['0xcccc000000000000000000000000000000000004']);
  assert.equal(s.get('0xcccc000000000000000000000000000000000004')!.verified, false);
  srv.close();
});
