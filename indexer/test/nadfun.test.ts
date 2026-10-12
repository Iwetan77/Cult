// Nad.fun average cost on simulated router events: every sell is a closed
// slice at the running average cost, so partial sells count as they land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestIndexer } from 'envio';

const W = '0x00000000000000000000000000000000000000bb';
const TOKEN = '0x00000000000000000000000000000000000000cc';
const E18 = 10n ** 18n;
const blk = (n: number) => ({ number: 66_300_000 + n, timestamp: 1_790_000_000 + n });
const tx = (n: number) => ({ hash: '0x' + (n + 100).toString(16).padStart(64, '0') });
const buy = (n: number, mon: bigint, tokens: bigint) => ({ contract: 'NadFunRouter', event: 'Buy', block: blk(n), transaction: tx(n), params: { buyer: W, token: TOKEN, amountIn: mon, amountOut: tokens, graduated: false } });
const sell = (n: number, tokens: bigint, mon: bigint) => ({ contract: 'NadFunRouter', event: 'Sell', block: blk(n), transaction: tx(n), params: { seller: W, token: TOKEN, amountIn: tokens, amountOut: mon, graduated: false } });

test('buy, sell half, buy more, sell all: each sell is a closed slice at average cost', async () => {
  const t = createTestIndexer();
  await t.process({
    chains: {
      10143: {
        startBlock: 66_300_001,
        endBlock: 66_300_004,
        simulate: [
          buy(1, 1n * E18, 100n * E18), // 100 tokens for 1 MON
          sell(2, 50n * E18, (6n * E18) / 10n), // half for 0.6 MON
          buy(3, 1n * E18, 50n * E18), // 50 more for 1 MON
          sell(4, 100n * E18, (15n * E18) / 10n), // all 100 for 1.5 MON
        ],
      },
    },
  } as never);
  const rt = (await (t as any).NadFunTrade.getAll()).sort((a: any, b: any) => Number(a.closedAt) - Number(b.closedAt));
  assert.equal(rt.length, 2, 'one slice per sell');
  // Half at 0.01 MON/token cost: 0.5 in, 0.6 out.
  assert.equal(Number(rt[0].costMon), 0.5);
  assert.equal(Number(rt[0].proceedsMon), 0.6);
  assert.equal(Number(rt[0].realizedPnlMon), 0.1);
  assert.equal(rt[0].isWin, true);
  // The rest at the new average (0.5 + 1) / 100: 1.5 in, 1.5 out.
  assert.equal(Number(rt[1].costMon), 1.5);
  assert.equal(Number(rt[1].proceedsMon), 1.5);
  assert.equal(Number(rt[1].realizedPnlMon), 0);
  assert.equal(rt[1].isWin, false);
  for (const r of rt) assert.equal(r.openTx, tx(1).hash, 'slices keep the opening tx (own vs copied)');
  const trader = await (t as any).Trader.get(W);
  assert.equal(trader.tradeCount, 2);
  assert.equal(Number(trader.realizedPnlMon), 0.1, 'total = proceeds - cost over the whole position');
});
