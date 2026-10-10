import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { holding, installOfflineFetch, ownFixture, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

before(installOfflineFetch);
afterEach(stopFixtures);
after(verifyOffline);

test('net holdings expose independent private, own, mirrored and stacked marker sizes and audiences', async () => {
  const f = await ownFixture();
  const privateLot = f.seedTrade('100', { cultIds: [] });
  const sharedLot = f.seedTrade('200', { cultIds: [f.cultB], entryPrice: 2 });
  const leader = f.seedTrade('300', { userId: f.shared });
  const copy = f.seedMirror(leader, '300');
  const stack = f.seedStack(leader, '400');
  const net = holding('perpl', '1000', { markPriceAusd: 3, valueAusd: 3000, pnlAusd: 999 });
  const out = f.allocatedHoldings(f.user, [net]);
  const byMarker = new Map(out.map(h => [h.markerId, h]));
  for (const [marker, raw, origin, cultIds] of [
    [`trade:${privateLot.id}`, '100', 'private', []],
    [`trade:${sharedLot.id}`, '200', 'leader', [f.cultB]],
    [`mirror:${copy.id}`, '300', 'auto_mirror', [f.cultA]],
    [`stack:${stack}`, '400', 'manual_stack', [f.cultA]],
  ] as const) {
    const h = byMarker.get(marker)!;
    assert.ok(h, marker);
    assert.equal(h.sizeRaw, raw);
    assert.equal(h.size, Number(raw));
    assert.equal(h.origin, origin);
    assert.deepEqual(h.cultIds, cultIds);
    assert.equal(h.isNetted, true);
    assert.equal(h.valueAusd, Number(raw) * 3);
  }
  assert.equal(byMarker.get(`trade:${privateLot.id}`)!.pnlAusd, 200);
  assert.equal(byMarker.get(`trade:${sharedLot.id}`)!.pnlAusd, 200);
  assert.equal(out.reduce((n, h) => n + BigInt(h.sizeRaw), 0n), 1000n);
  assert.equal(net.pnlAusd, 999, 'allocation does not mutate the venue holding');
});

test('unattributed venue balance gets one private residual without growing tracked lots', async () => {
  const f = await ownFixture();
  const tracked = f.seedTrade('100', { cultIds: [f.cultA] });
  const out = f.allocatedHoldings(f.user, [holding('perpl', '150')]);
  assert.equal(out.find(h => h.markerId === `trade:${tracked.id}`)!.sizeRaw, '100');
  const residual = out.find(h => h.markerId === 'private:16')!;
  assert.equal(residual.sizeRaw, '50');
  assert.equal(residual.origin, 'private');
  assert.deepEqual(residual.cultIds, []);
  assert.equal(f.repo.trades.get(tracked.id)!.size, '100');
});

test('external net decreases clamp all allocations together and never overclaim or close stored lots', async () => {
  const f = await ownFixture();
  const a = f.seedTrade('17');
  const b = f.seedTrade('29', { cultIds: [] });
  const leader = f.seedTrade('31', { userId: f.shared });
  const copy = f.seedMirror(leader, '31');
  const stack = f.seedStack(leader, '23');
  for (let raw = 1n; raw <= 110n; raw++) {
    const out = f.allocatedHoldings(f.user, [holding('perpl', raw.toString())]);
    assert.equal(out.reduce((n, h) => n + BigInt(h.sizeRaw), 0n), raw, `conservation at ${raw}`);
    assert.ok(out.every(h => BigInt(h.sizeRaw) > 0n && BigInt(h.sizeRaw) <= raw));
    assert.equal(new Set(out.map(h => h.markerId)).size, out.length);
    assert.ok(out.reduce((n, h) => n + h.size, 0) <= Number(raw) + 1e-9);
    assert.ok(out.reduce((n, h) => n + h.valueAusd, 0) <= Number(raw) * 2 + 1e-9);
  }
  assert.equal(f.repo.trades.get(a.id)!.size, '17');
  assert.equal(f.repo.trades.get(b.id)!.closedAt, null);
  assert.equal(f.repo.mirrors.get(copy.id)!.status, 'open');
  assert.equal(f.getDb().prepare('SELECT size, status FROM stacks WHERE id = ?').get(stack)!.status, 'open');
});

test('raw allocation conservation remains exact beyond safe JavaScript integer precision', async () => {
  const f = await ownFixture();
  f.seedTrade('900719925474099312345');
  f.seedTrade('900719925474099312346', { cultIds: [] });
  for (const raw of ['1', '9007199254740993', '900719925474099312347', '1801439850948198624691']) {
    const out = f.allocatedHoldings(f.user, [holding('perpl', raw)]);
    assert.equal(out.reduce((n, h) => n + BigInt(h.sizeRaw), 0n), BigInt(raw));
    assert.ok(out.every(h => BigInt(h.sizeRaw) > 0n));
  }
});

test('closed, foreign, opposite-side and different-market markers cannot claim a holding', async () => {
  const f = await ownFixture();
  const valid = f.seedTrade('20');
  const closed = f.seedTrade('100');
  f.repo.trades.markClosed(closed.id);
  f.seedTrade('100', { userId: f.stranger });
  f.seedTrade('100', { side: 'short' });
  f.seedTrade('100', { market: '32' });
  const leader = f.seedTrade('100', { userId: f.shared });
  const closedCopy = f.seedMirror(leader, '100');
  f.repo.mirrors.transition(closedCopy.id, 'open', 'closed');
  const closedStack = f.seedStack(leader, '100');
  f.getDb().prepare('UPDATE stacks SET status = ? WHERE id = ?').run('closed', closedStack);
  const out = f.allocatedHoldings(f.user, [holding('perpl', '20')]);
  assert.deepEqual(out.map(h => h.markerId), [`trade:${valid.id}`]);
  assert.equal(out[0].sizeRaw, '20');
});

test('zero or unavailable holdings make no claims and never mark stored allocations closed', async () => {
  const f = await ownFixture();
  const t = f.seedTrade('100');
  assert.deepEqual(f.allocatedHoldings(f.user, []), []);
  assert.deepEqual(f.allocatedHoldings(f.user, [holding('perpl', '0')]), []);
  assert.equal(f.repo.trades.get(t.id)!.closedAt, null);
  assert.equal(f.repo.trades.get(t.id)!.size, '100');
});

test('short PnL uses the short direction and spot allocations are not marked netted', async () => {
  const f = await ownFixture();
  const short = f.seedTrade('10', { side: 'short', entryPrice: 3 });
  const shortView = f.allocatedHoldings(f.user, [holding('perpl', '10', { side: 'short', markPriceAusd: 2 })])[0];
  assert.equal(shortView.markerId, `trade:${short.id}`);
  assert.equal(shortView.pnlAusd, 10);
  const spot = await f.ownOpen('nadfun', [], 20);
  const spotView = f.allocatedHoldings(f.user, [holding('nadfun', '20')])[0];
  assert.equal(spotView.markerId, spot.markerId);
  assert.equal(spotView.origin, 'private');
  assert.equal(spotView.isNetted, false);
});
