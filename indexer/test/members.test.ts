// Members only: with CULT_API_URL set, trades by wallets and Perpl accounts
// that aren't on the backend's member list leave nothing behind, and a member's
// Perpl account created before the start block is still picked up.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const MEMBER = '0x00000000000000000000000000000000000000aa';
const STRANGER = '0x00000000000000000000000000000000000000ee';
const TOKEN = '0x00000000000000000000000000000000000000cc';
const E18 = 10n ** 18n;

let asked = 0;
const server = createServer((req, res) => {
  if (req.url !== '/v1/indexer/accounts' || req.headers['x-indexer-key'] !== 'k') {
    res.writeHead(403).end();
    return;
  }
  asked++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ accounts: [{ userId: 'u1', wallet: MEMBER.toUpperCase().replace('0X', '0x'), perplAccountId: 9, clanIds: [] }] }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
process.env.CULT_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
process.env.INDEXER_API_KEY = 'k';

const { createTestIndexer } = await import('envio');

const blk = (n: number) => ({ number: 66_320_000 + n, timestamp: 1_790_000_000 + n });
const tx = (n: number) => ({ hash: '0x' + (n + 500).toString(16).padStart(64, '0') });
const perpl = (n: number, event: string, params: object) => ({ contract: 'Exchange', event, block: blk(n), transaction: tx(n), params });
const open = (n: number, accountId: bigint) =>
  perpl(n, 'PositionOpenedV2', { perpId: 16n, accountId, positionType: 0n, leverageHdths: 500n, depositCNS: 20_000_000_000n, pnlCollateralizedCNS: 0n, pricePNS: 1_000_000n, lotLNS: 100_000n, insFeeCNS: 0n });
const close = (n: number, accountId: bigint) =>
  perpl(n, 'PositionClosed', { perpId: 16n, accountId, positionType: 0n, pricePNS: 1_100_000n, deltaPnlCNS: 10_000_000_000n, fundingCNS: 0n });
const nad = (n: number, event: 'Buy' | 'Sell', who: string, amountIn: bigint, amountOut: bigint) => ({
  contract: 'NadFunRouter',
  event,
  block: blk(n),
  transaction: tx(n),
  params: { [event === 'Buy' ? 'buyer' : 'seller']: who, token: TOKEN, amountIn, amountOut, graduated: false },
});

test('only members are indexed; a member account from before the start block still counts', async () => {
  const t = createTestIndexer();
  await t.process({
    chains: {
      10143: {
        startBlock: 66_320_001,
        endBlock: 66_320_008,
        simulate: [
          // a stranger's account, created in range, trades a round trip
          perpl(1, 'AccountCreated', { account: STRANGER, id: 7n }),
          open(2, 7n),
          close(3, 7n),
          // the member's account 9 was created before the start block: no
          // AccountCreated, known only from the backend's list
          open(4, 9n),
          close(5, 9n),
          // Nad.fun: stranger and member each buy and sell out
          nad(6, 'Buy', STRANGER, 1n * E18, 100n * E18),
          nad(6, 'Buy', MEMBER, 1n * E18, 100n * E18),
          nad(7, 'Sell', STRANGER, 100n * E18, 2n * E18),
          nad(8, 'Sell', MEMBER, 100n * E18, 2n * E18),
        ],
      },
    },
  } as never);
  const x = t as any;
  const trades = await x.Trade.getAll();
  assert.equal(trades.length, 1, 'only the member closed a Perpl round trip');
  assert.equal(trades[0].trader_id, MEMBER);
  const nadTrades = await x.NadFunTrade.getAll();
  assert.equal(nadTrades.length, 1, 'only the member closed a Nad.fun round trip');
  assert.equal(nadTrades[0].trader_id, MEMBER);
  const traders = await x.Trader.getAll();
  assert.deepEqual(traders.map((r: { id: string }) => r.id), [MEMBER], 'no row for the stranger');
  assert.equal(traders[0].tradeCount, 2);
  assert.equal((await x.PerplAccount.getAll()).length, 1, 'the stranger account is not stored');
  assert.equal((await x.PositionEvent.getAll()).every((e: { trader_id: string }) => e.trader_id === MEMBER), true);
  assert.equal((await x.NadFunEvent.getAll()).every((e: { trader_id: string }) => e.trader_id === MEMBER), true);
  assert.ok(asked >= 1, 'the member list came from the backend');
});
