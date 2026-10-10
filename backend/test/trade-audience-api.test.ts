import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fill, holding, installOfflineFetch, meme, ownFixture, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

process.env.NODE_ENV = 'test';
process.env.DEV_AUTH = '1';
process.env.LOG_REQUESTS = '0';

let createApp: typeof import('../src/api/server.js')['createApp'];
before(async () => {
  installOfflineFetch();
  ({ createApp } = await import('../src/api/server.js'));
});
afterEach(stopFixtures);
after(verifyOffline);

async function fixture(ready = true) {
  const f = await ownFixture();
  if (!ready) f.members.setForwarding(f.user, false);
  const app = createApp(f.engine);
  const request = (path: string, body?: unknown, userId = f.user) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Dev ${userId} ${f.members.get(userId)!.wallet}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const open = (body: unknown, userId = f.user) => request('/v1/positions/open', body, userId);
  return { ...f, app, request, open };
}

test('unfinished setup never creates an own-order request or trade', async () => {
  const f = await fixture(false);
  const response = await f.open({ marketId: '16', side: 'long', marginUsd: 10, cultIds: [] });
  assert.equal(response.status, 409);
  assert.deepEqual(f.orders(), []);
  assert.deepEqual(f.repo.trades.openOnMarket(f.user, 'perpl', '16'), []);
  assert.equal(f.opens.length, 0);
});

test('invalid Perpl and meme sides never reach the adapter or create a request', async () => {
  const f = await fixture();
  for (const [marketId, side] of [['16', 'buy'], [meme, 'long']]) {
    const response = await f.open({ marketId, side, marginUsd: 10, cultIds: [f.cultA] });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(f.orders(), []);
  assert.equal(f.opens.length, 0);
});

test('an invalid market cannot create a private request or lot', async () => {
  const f = await fixture();
  const response = await f.open({ marketId: '999999', side: 'long', marginUsd: 10, cultIds: [] });
  assert.notEqual(response.status, 200);
  assert.deepEqual(f.orders(), []);
  assert.equal(f.opens.length, 0);
});

test('actual engine API opens persist independent same-asset audience selections and marker IDs', async () => {
  const f = await fixture();
  const results: { tradeId: string; markerId: string }[] = [];
  for (const cultIds of [[], [f.cultA], [f.cultB]]) {
    const response = await f.open({ marketId: '16', side: 'long', marginUsd: 10, leverage: 2, cultIds });
    assert.equal(response.status, 200);
    const result = await response.json() as { tradeId: string; markerId: string };
    results.push(result);
    const order = f.memberOrders.get(result.tradeId)!;
    const trade = f.repo.trades.get(result.tradeId)!;
    assert.deepEqual(order.cultIds, cultIds);
    assert.deepEqual(trade.cultIds, cultIds);
    assert.equal(order.bookedSize, '20');
    assert.equal(trade.size, '20');
    assert.equal(result.markerId, `trade:${trade.id}`);
    assert.ok(order.rq != null && order.accountId != null);
    assert.equal(f.memberOrders.perpl(order.accountId!, order.rq!)!.id, trade.id);
  }
  assert.equal(new Set(results.map(r => r.tradeId)).size, 3);
  assert.equal(f.repo.mirrors.forTrade(results[0].tradeId).length, 0);
  assert.ok(f.repo.mirrors.forTrade(results[1].tradeId).every(m => m.clanId === f.cultA));
  assert.ok(f.repo.mirrors.forTrade(results[2].tradeId).every(m => m.clanId === f.cultB));
});

test('omitted audience uses administered cults and one copy per follower across cults', async () => {
  const f = await fixture();
  const response = await f.open({ marketId: '16', side: 'long', marginUsd: 10 });
  assert.equal(response.status, 200);
  const result = await response.json() as { tradeId: string };
  assert.deepEqual([...f.memberOrders.get(result.tradeId)!.cultIds].sort(), [f.cultA, f.cultB].sort());
  assert.deepEqual([...f.repo.trades.get(result.tradeId)!.cultIds!].sort(), [f.cultA, f.cultB].sort());
  const copies = f.repo.mirrors.forTrade(result.tradeId);
  assert.equal(copies.length, 3);
  assert.equal(copies.filter(m => m.userId === f.shared).length, 1);
});

test('nonmembers and ordinary members cannot post an API trade to an unauthorized cult', async () => {
  const f = await fixture();
  const body = { marketId: '16', side: 'long', marginUsd: 10, cultIds: [f.cultA] };
  assert.equal((await f.open(body, f.stranger)).status, 400);
  assert.equal((await f.open(body, f.shared)).status, 403);
  assert.equal(f.opens.length, 0);
  assert.deepEqual(f.orders(f.stranger), []);
  assert.deepEqual(f.orders(f.shared), []);
});

test('synchronous and asynchronous venue failures retain failed request refs without successful lots', async t => {
  for (const venue of ['perpl', 'nadfun'] as const) for (const sync of [false, true]) {
    await t.test(`${venue} ${sync ? 'synchronous' : 'asynchronous'}`, async () => {
      const f = await fixture();
      const rejected = () => { throw new Error('offline rejection'); };
      t.mock.method(f.adapters[venue], 'open', sync ? rejected : async () => rejected());
      const response = await f.open({ marketId: venue === 'perpl' ? '16' : meme,
        side: venue === 'perpl' ? 'long' : 'buy', marginUsd: 10, cultIds: [] });
      assert.equal(response.status, 500);
      assert.equal(f.orders().length, 1);
      assert.equal(f.orders()[0].state, 'failed');
      assert.equal(f.orders()[0].bookedSize, '0');
      assert.equal(f.repo.trades.get(f.orders()[0].id), null);
    });
  }
});

test('zero-filled API opens do not return success or create trade and mirror rows', async () => {
  const f = await fixture();
  f.controls.open = (_input, proposed) => ({ ...proposed, sizeRaw: '0', size: 0, notionalAusd: 0 });
  const response = await f.open({ marketId: '16', side: 'long', marginUsd: 10, cultIds: [f.cultA] });
  assert.equal(response.status, 409);
  assert.equal(f.repo.trades.get(f.orders()[0].id), null);
  assert.deepEqual(f.repo.mirrors.forTrade(f.orders()[0].id), []);
});

test('opposite-side API opens are refused before the mock adapter receives an order', async () => {
  const f = await fixture();
  f.put(f.user, holding('perpl', '100', { side: 'short' }));
  const response = await f.open({ marketId: '16', side: 'long', marginUsd: 10, cultIds: [] });
  assert.equal(response.status, 409);
  assert.equal(f.opens.length, 0);
  assert.equal(f.orders().length, 0);
});

test('API close passes marker scope and books only the confirmed partial fill', async () => {
  const f = await fixture();
  const a = await f.ownOpen('perpl', [f.cultA], 100);
  const b = await f.ownOpen('perpl', [f.cultB], 50);
  f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '99', size: 99, notionalAusd: 99 });
  const response = await f.request('/v1/positions/close', { marketId: '16', markerId: a.markerId });
  assert.equal(response.status, 200);
  const result = await response.json() as { markerId: string };
  assert.equal(result.markerId, a.markerId);
  assert.equal(f.repo.trades.get(a.tradeId!)!.size, '1');
  assert.equal(f.repo.trades.get(a.tradeId!)!.closedAt, null);
  assert.equal(f.repo.trades.get(b.tradeId!)!.size, '50');
  assert.equal(f.repo.trades.get(b.tradeId!)!.closedAt, null);
  assert.equal(f.closes[0].sizeRaw, '100');
  assert.equal(f.orders().at(-1)!.markerId, a.markerId);
});

test('API close refuses a foreign marker and oversized target quantity without sending', async () => {
  const f = await fixture();
  const own = await f.ownOpen('perpl', [], 100);
  const foreign = f.seedTrade('50', { userId: f.stranger });
  assert.equal((await f.request('/v1/positions/close', { marketId: '16', markerId: `trade:${foreign.id}` })).status, 404);
  assert.equal((await f.request('/v1/positions/close', { marketId: '16', markerId: own.markerId, sizeRaw: '101' })).status, 409);
  assert.equal(f.closes.length, 0);
  assert.equal(f.orders().filter(o => o.kind === 'close').length, 0);
});

test('positions API returns the allocated holdings rather than a duplicated net balance', async t => {
  const f = await fixture();
  const a = await f.ownOpen('perpl', [], 70);
  const b = await f.ownOpen('perpl', [f.cultA], 30);
  const { perpl } = await import('../src/venues/perpl.js');
  const { nadfun } = await import('../src/venues/nadfun.js');
  t.mock.method(perpl, 'holdings', f.adapters.perpl.holdings);
  t.mock.method(nadfun, 'holdings', async () => []);
  const response = await f.request('/v1/positions');
  assert.equal(response.status, 200);
  const { positions } = await response.json() as { positions: { markerId: string; origin: string; sizeRaw: string; cultIds: string[] }[] };
  assert.equal(positions.length, 2);
  assert.equal(positions.find(p => p.markerId === a.markerId)!.sizeRaw, '70');
  assert.equal(positions.find(p => p.markerId === a.markerId)!.origin, 'private');
  assert.deepEqual(positions.find(p => p.markerId === a.markerId)!.cultIds, []);
  assert.equal(positions.find(p => p.markerId === b.markerId)!.sizeRaw, '30');
  assert.deepEqual(positions.find(p => p.markerId === b.markerId)!.cultIds, [f.cultA]);
  assert.equal(positions.reduce((n, p) => n + BigInt(p.sizeRaw), 0n), 100n);
});

test('Nad.fun API orders persist tx identity and the selected audience on the actual filled lot', async () => {
  const f = await fixture();
  const response = await f.open({ marketId: meme, side: 'buy', marginUsd: 10, cultIds: [f.cultB] });
  assert.equal(response.status, 200);
  const result = await response.json() as { tradeId: string; txHash: string };
  assert.equal(f.memberOrders.tx(result.txHash)!.id, result.tradeId);
  assert.deepEqual(f.repo.trades.get(result.tradeId)!.cultIds, [f.cultB]);
  assert.equal(f.repo.trades.get(result.tradeId)!.size, '10');
});
