import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

const { getContext, maxLeverageHundredths } = await import('../src/perpl/context.js');
const { checkLeverage, LeverageError, openPosition } = await import('../src/trading/positions.js');
const { toApiMarket } = await import('../src/api/chart.js');
import type { Market, OrderSpec } from '../src/perpl/types.js';
import type { TradingSession } from '../src/perpl/session.js';

const market = (initialMargin = 300): Market => ({
  id: 64, symbol: 'MON', name: 'MON Perp', order_ttl_blocks: 20,
  order_max_market_slippage_bps: 100, funding_interval_sec: 2580, funding_interval_blocks: 8571,
  config: { is_open: true, price_decimals: 5, size_decimals: 0, initial_margin: initialMargin,
    maintenance_margin: 500, maker_fee: 45, taker_fee: 345 },
});

test('Perpl initial margin uses the same hundredths as order leverage, not basis points', () => {
  for (const [raw, max] of [[300, 3], [750, 7.5], [5000, 50]]) {
    const m = market(raw);
    assert.equal(maxLeverageHundredths(m), raw);
    assert.equal(toApiMarket(m).maxLeverage, max);
    assert.equal(checkLeverage(m, max), raw);
    assert.throws(() => checkLeverage(m, max + 0.01), LeverageError);
  }
});

test('the rejected MON 10x request is invalid at the real 3x ceiling', () => {
  assert.throws(() => checkLeverage(market(), 10), /MON supports up to 3x/);
  for (const invalid of [0, -1, NaN, Infinity]) assert.throws(() => checkLeverage(market(), invalid), LeverageError);
});

test('MON accepts 3x and sends lv=300, while rejecting 10x before sending an order', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ markets: [market()] }));
  await getContext(true);
  const sent: Omit<OrderSpec, 'rq' | 'lb'>[] = [];
  const session = { placeOrder: async (spec: Omit<OrderSpec, 'rq' | 'lb'>) => {
    sent.push(spec);
    return { st: 4, fs: spec.s, lv: spec.lv };
  } } as unknown as TradingSession;
  const params = { accountId: 925, marketId: 64, side: 'long' as const, size: 5592, leverage: 3 };
  await openPosition(session, params);
  assert.equal(sent[0].lv, 300);
  assert.equal(sent[0].s, 5592);
  await assert.rejects(openPosition(session, { ...params, leverage: 10 }), LeverageError);
  assert.equal(sent.length, 1);
});

test('unsupported leverage is rejected by the adapter before accessing funding or the signer', async t => {
  const { members } = await import('../src/store/members.js');
  const { perpl } = await import('../src/venues/perpl.js');
  members.upsert('leverage-test', '0x' + '1'.repeat(40));
  members.setAccount('leverage-test', 925);
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path.endsWith('/pub/context')) return Response.json({ markets: [market()] });
    if (path.endsWith('/market-data/ticker')) return Response.json({ d: { '64': { mrk: 2683 } } });
    throw new Error('Unexpected funding request');
  });
  await getContext(true);
  await assert.rejects(perpl.open({ userId: 'leverage-test', market: '64', side: 'long', notionalAusd: 500, leverage: 10 }), LeverageError);
  assert.equal(requests.length, 2);
});
