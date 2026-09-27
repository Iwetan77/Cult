import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

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
            { id: '0xaaaa000000000000000000000000000000000001', tradeCount: 4, winRate: 0.75, realizedPnlUsd: '12.5', realizedPnlMon: '-0.5', lastTradeAt: '1790000000000' },
            { id: '0xaaaa000000000000000000000000000000000002', tradeCount: 0, winRate: 0, realizedPnlUsd: '0', realizedPnlMon: '0', lastTradeAt: null },
          ],
        },
      }),
    );
  });
});
await new Promise<void>((ok) => srv.listen(0, ok));
process.env.INDEXER_GRAPHQL_URL = `http://127.0.0.1:${(srv.address() as any).port}/v1/graphql`;
const { statsFor, toStats } = await import('../src/indexer/stats.js');

test('one query for many wallets, lowercased, mapped; unknown wallets are unverified', async () => {
  const s = await statsFor(['0xAAAA000000000000000000000000000000000001', '0xaaaa000000000000000000000000000000000002', '0xbbbb000000000000000000000000000000000003']);
  assert.deepEqual(lastBody.variables.ids, ['0xaaaa000000000000000000000000000000000001', '0xaaaa000000000000000000000000000000000002', '0xbbbb000000000000000000000000000000000003']);
  const a = s.get('0xaaaa000000000000000000000000000000000001')!;
  assert.equal(a.verified, true);
  assert.equal(a.tradeCount, 4);
  assert.equal(a.winRate, 0.75);
  assert.equal(a.realizedPnlPerplUsd, 12.5);
  assert.equal(a.realizedPnlMon, -0.5);
  const b = s.get('0xaaaa000000000000000000000000000000000002')!;
  assert.equal(b.verified, true);
  assert.equal(b.winRate, null, 'no closed trades: null, not 0%');
  const c = s.get('0xbbbb000000000000000000000000000000000003')!;
  assert.equal(c.verified, false);
  assert.equal(c.realizedPnlUsd, null);
});

test('combined $ uses the stated MON price; no price means no combined figure unless MON pnl is 0', () => {
  const row = { id: 'x', tradeCount: 1, winRate: 1, realizedPnlUsd: '10', realizedPnlMon: '100', lastTradeAt: null };
  const s = toStats(row, 0.03);
  assert.ok(Math.abs(s.realizedPnlUsd! - 13) < 1e-9);
  assert.equal(s.monPriceUsed, 0.03);
  assert.equal(toStats(row, null).realizedPnlUsd, null);
  assert.equal(toStats({ ...row, realizedPnlMon: '0' }, null).realizedPnlUsd, 10);
});

test('indexer errors degrade to unverified, never throw', async () => {
  mode = 'error';
  const s = await statsFor(['0xcccc000000000000000000000000000000000004']);
  assert.equal(s.get('0xcccc000000000000000000000000000000000004')!.verified, false);
  srv.close();
});
