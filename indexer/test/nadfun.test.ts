// Nad.fun average cost on simulated router events: buy, sell half, buy more,
// sell all = one round trip, realized = proceeds - cost.
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

test('buy, sell half, buy more, sell all: one round trip at average cost', async () => {
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
  const rt = await (t as any).NadFunTrade.getAll();
  assert.equal(rt.length, 1);
  assert.equal(rt[0].buyCount, 2);
  assert.equal(rt[0].sellCount, 2);
  assert.equal(Number(rt[0].costMon), 2);
  assert.equal(Number(rt[0].proceedsMon), 2.1);
  assert.equal(Number(rt[0].realizedPnlMon), 0.1, 'closed at 0: realized = proceeds - cost');
  assert.equal(rt[0].isWin, true);
});
