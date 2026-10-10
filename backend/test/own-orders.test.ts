import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderStatus, PositionStatus } from '../src/perpl/types.js';
import type { Fill, Venue } from '../src/venues/types.js';
import type { Position } from '../src/perpl/types.js';
import { fill, flush, holding, installOfflineFetch, marketFor, ownFixture, sideFor, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

before(installOfflineFetch);
afterEach(stopFixtures);
after(verifyOffline);

type Fixture = Awaited<ReturnType<typeof ownFixture>>;
const status = (code: number) => (error: unknown) => (error as { status?: number }).status === code;
const lot = (f: Fixture, result: Fill) => f.repo.trades.get(result.tradeId!)!;
const close = (f: Fixture, markerId?: string, sizeRaw?: string, v: Venue = 'perpl') =>
  f.engine.executeOwnClose({ userId: f.user, market: marketFor(v), sizeRaw }, markerId);

function request(f: Fixture, v: Venue = 'perpl', cultIds: string[] = []) {
  return f.memberOrders.begin({ userId: f.user, venue: v, market: marketFor(v), kind: 'open', side: sideFor(v),
    leverage: v === 'perpl' ? 200 : 100, marginFraction: 0.1, cultIds, markerId: null, requestedNotional: 100 });
}

function position(f: Fixture, raw: number, rq = 900000): Position {
  return { acc: f.members.get(f.user)!.perplAccountId!, pid: 700, mkt: 16, rq,
    sr: 14, sd: 1, s: raw, ep: 1, lv: 200, c: '100000000', st: PositionStatus.Open } as Position;
}

for (const venue of ['perpl', 'nadfun'] as const) {
  test(`${venue}: private then shared same-asset opens create independent lots and durable audiences`, async () => {
    const f = await ownFixture();
    const first = await f.ownOpen(venue, [], 70);
    const second = await f.ownOpen(venue, [f.cultA], 30);
    assert.notEqual(first.tradeId, second.tradeId);
    assert.equal(first.markerId, `trade:${first.tradeId}`);
    assert.equal(second.markerId, `trade:${second.tradeId}`);
    assert.deepEqual(lot(f, first).cultIds, []);
    assert.deepEqual(lot(f, second).cultIds, [f.cultA]);
    assert.equal(lot(f, first).size, '70');
    assert.equal(lot(f, second).size, '30');
    assert.equal(f.repo.mirrors.forTrade(first.tradeId!).length, 0);
    assert.deepEqual(f.repo.mirrors.forTrade(second.tradeId!).map(m => m.userId).sort(), [f.shared, f.followerA].sort());
    assert.deepEqual(f.orders().map(o => o.cultIds), [[], [f.cultA]]);
    assert.ok(f.orders().every(o => o.bookedSize !== '0' && o.state === 'filled'));
  });

  test(`${venue}: A, B, private and all-cult audiences never migrate between same-asset lots`, async () => {
    const f = await ownFixture();
    const a = await f.ownOpen(venue, [f.cultA], 11);
    const b = await f.ownOpen(venue, [f.cultB], 22);
    const privateLot = await f.ownOpen(venue, [], 33);
    const all = await f.engine.executeOwnOpen({ userId: f.user, market: marketFor(venue), side: sideFor(venue), notionalAusd: 44 });
    assert.equal(new Set([a.tradeId, b.tradeId, privateLot.tradeId, all.tradeId]).size, 4);
    assert.deepEqual([lot(f, a).cultIds, lot(f, b).cultIds, lot(f, privateLot).cultIds], [[f.cultA], [f.cultB], []]);
    assert.deepEqual([...lot(f, all).cultIds!].sort(), [f.cultA, f.cultB].sort());
    const copies = f.repo.mirrors.forTrade(all.tradeId!);
    assert.equal(copies.filter(m => m.userId === f.shared).length, 1, 'one copy per follower across posted cults');
    assert.equal(copies.length, 3);
    assert.ok(copies.every(m => [f.cultA, f.cultB].includes(m.clanId)));
  });

  test(`${venue}: refs and selected audience exist before the adapter reports a fill`, async () => {
    const f = await ownFixture();
    f.controls.open = (_input, proposed) => {
      const order = f.orders().at(-1)!;
      assert.equal(order.state, 'pending');
      assert.deepEqual(order.cultIds, [f.cultB]);
      assert.equal(order.bookedSize, '0');
      assert.equal(f.repo.trades.get(order.id), null);
      assert.equal(venue === 'perpl' ? f.memberOrders.perpl(f.members.get(f.user)!.perplAccountId!, proposed.requestId!)!.id : f.memberOrders.tx(proposed.txHash!)!.id, order.id);
      return proposed;
    };
    const opened = await f.ownOpen(venue, [f.cultB]);
    assert.equal(f.orders()[0].id, opened.tradeId);
    const forwarded: unknown[] = [];
    f.controls.close = (_input, proposed) => {
      const order = f.orders().at(-1)!;
      assert.equal(order.kind, 'close');
      assert.equal(order.markerId, opened.markerId);
      assert.deepEqual(order.targets.map(({ markerId, size }) => ({ markerId, size })), [{ markerId: opened.markerId, size: '100' }]);
      assert.equal(venue === 'perpl' ? f.memberOrders.perpl(order.accountId!, proposed.requestId!)!.id : f.memberOrders.tx(proposed.txHash!)!.id, order.id);
      return proposed;
    };
    await f.engine.executeOwnClose({ userId: f.user, market: marketFor(venue), onRef: ref => forwarded.push(ref) }, opened.markerId);
    assert.equal(forwarded.length, 1);
    assert.ok(lot(f, opened).closedAt);
  });

  test(`${venue}: zero-filled opens reject without successful lots or mirrors`, async () => {
    const f = await ownFixture();
    const notices: unknown[] = [];
    f.engine.on('trade', t => notices.push(t));
    f.controls.open = (_input, proposed) => ({ ...proposed, sizeRaw: '0', size: 0, notionalAusd: 0 });
    await assert.rejects(f.ownOpen(venue, [f.cultA]), status(409));
    assert.deepEqual(f.repo.trades.openOnMarket(f.user, venue, marketFor(venue)), []);
    assert.equal(f.orders()[0].state, 'failed', 'retain the failed request/ref for later reconciliation');
    assert.equal(f.orders()[0].bookedSize, '0');
    assert.equal(f.repo.mirrors.forTrade(f.orders()[0].id).length, 0);
    assert.deepEqual(notices, []);
  });

  test(`${venue}: rejected and zero-filled closes leave the targeted lot open`, async () => {
    const f = await ownFixture();
    const opened = await f.ownOpen(venue, [], 100);
    f.controls.close = () => { throw new Error('offline close rejected'); };
    await assert.rejects(close(f, opened.markerId, undefined, venue), /offline close rejected/);
    f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '0', size: 0, notionalAusd: 0 });
    await assert.rejects(close(f, opened.markerId, undefined, venue), status(409));
    assert.equal(lot(f, opened).closedAt, null);
    assert.equal(lot(f, opened).size, '100');
    assert.ok(f.orders().filter(o => o.kind === 'close').every(o => o.state === 'failed' && o.bookedSize === '0'));
  });

  test(`${venue}: scoped partial fills, including less than 1% remaining, stay open`, async () => {
    const f = await ownFixture();
    const a = await f.ownOpen(venue, [f.cultA], 10000);
    const b = await f.ownOpen(venue, [f.cultB], 50);
    f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '9999', size: 9999, notionalAusd: 9999 });
    await close(f, a.markerId, undefined, venue);
    assert.equal(lot(f, a).size, '1');
    assert.equal(lot(f, a).closedAt, null);
    assert.equal(lot(f, b).size, '50');
    assert.equal(lot(f, b).closedAt, null);
    assert.equal(f.orders().at(-1)!.bookedSize, '9999');
    f.controls.close = undefined;
    await close(f, a.markerId, undefined, venue);
    assert.ok(lot(f, a).closedAt);
    assert.equal(lot(f, b).closedAt, null);
  });

  test(`${venue}: cumulative fills tolerate duplicates, older snapshots and simultaneous bookings`, async () => {
    const f = await ownFixture();
    const order = request(f, venue, [f.cultB]);
    const tradeEvents: unknown[] = [];
    f.engine.on('trade', t => tradeEvents.push(t));
    await Promise.all(['40', '100', '60', '100', '80'].map(raw => f.engine.bookOwnFill(order.id, fill(venue, raw))));
    assert.equal(f.repo.trades.get(order.id)!.size, '100');
    assert.equal(f.memberOrders.get(order.id)!.bookedSize, '100');
    assert.deepEqual(f.repo.trades.get(order.id)!.cultIds, [f.cultB]);
    assert.equal(tradeEvents.length, 1);
    assert.equal(f.repo.mirrors.forTrade(order.id).filter(m => m.userId === f.shared).length, 1);
    assert.equal(f.repo.mirrors.forTrade(order.id).length, 2);
  });

  test(`${venue}: a fresh engine books a persisted request without resubmitting it`, async () => {
    const f = await ownFixture();
    const order = request(f, venue, [f.cultA]);
    f.memberOrders.ref(order.id, venue === 'perpl' ? { accountId: f.members.get(f.user)!.perplAccountId!, rq: 777 } : { txHash: '0xABC' });
    f.memberOrders.failed(order.id);
    const recovered = f.makeEngine();
    await recovered.bookOwnFill(order.id, fill(venue, '40'));
    await recovered.bookOwnFill(order.id, fill(venue, '100'));
    await recovered.bookOwnFill(order.id, fill(venue, '40'));
    assert.equal(f.repo.trades.get(order.id)!.size, '100');
    assert.deepEqual(f.repo.trades.get(order.id)!.cultIds, [f.cultA]);
    assert.equal(f.memberOrders.get(order.id)!.state, 'filled');
    assert.equal(f.opens.length, 0);
  });
}

test('a close books only the selected own, copied or stacked marker', async t => {
  for (const kind of ['trade', 'mirror', 'stack'] as const) await t.test(kind, async () => {
    const f = await ownFixture();
    const own = f.seedTrade('100');
    const leader = f.seedTrade('100', { userId: f.shared });
    const mirror = f.seedMirror(leader, '100');
    const stack = f.seedStack(leader, '100');
    f.put(f.user, holding('perpl', '300'));
    const markers = { trade: `trade:${own.id}`, mirror: `mirror:${mirror.id}`, stack: `stack:${stack}` };
    f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '40', size: 40, notionalAusd: 40 });
    await close(f, markers[kind]);
    const stackRow = f.getDb().prepare('SELECT size, status FROM stacks WHERE id = ?').get(stack)!;
    assert.equal(f.repo.trades.get(own.id)!.size, kind === 'trade' ? '60' : '100');
    assert.equal(f.repo.mirrors.get(mirror.id)!.size, kind === 'mirror' ? '60' : '100');
    assert.equal(stackRow.size, kind === 'stack' ? '60' : '100');
    assert.equal(f.repo.trades.get(own.id)!.closedAt, null);
    assert.equal(f.repo.mirrors.get(mirror.id)!.status, 'open');
    assert.equal(stackRow.status, 'open');
    assert.equal(f.closes[0].sizeRaw, '100');
    assert.deepEqual(f.orders()[0].targets.map(({ markerId, size }) => ({ markerId, size })), [{ markerId: markers[kind], size: '100' }]);
  });
});

test('manual copied and stacked closes retain a nonzero residual below 1%', async t => {
  for (const kind of ['mirror', 'stack'] as const) await t.test(kind, async () => {
    const f = await ownFixture();
    const leader = f.seedTrade('10000', { userId: f.shared });
    const mirror = f.seedMirror(leader, '10000');
    const stack = f.seedStack(leader, '10000');
    f.put(f.user, holding('perpl', '20000'));
    const marker = kind === 'mirror' ? `mirror:${mirror.id}` : `stack:${stack}`;
    f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '9999', size: 9999, notionalAusd: 9999 });
    await close(f, marker);
    const current = kind === 'mirror' ? f.repo.mirrors.get(mirror.id)! : f.getDb().prepare('SELECT size, status FROM stacks WHERE id = ?').get(stack)!;
    assert.equal(current.size, '1');
    assert.equal(current.status, 'open');
    assert.equal(f.repo.trades.get(leader.id)!.closedAt, null);
  });
});

test('foreign, closed, wrong-market and oversized marker closes are rejected before sending', async () => {
  const f = await ownFixture();
  const own = f.seedTrade('100');
  const foreign = f.seedTrade('50', { userId: f.stranger });
  const other = f.seedTrade('50', { market: '32' });
  const closedLot = f.seedTrade('50');
  f.repo.trades.markClosed(closedLot.id);
  f.put(f.user, holding('perpl', '100'));
  for (const marker of [`trade:${foreign.id}`, `trade:${other.id}`, `trade:${closedLot.id}`, 'trade:missing', 'mirror:missing', 'stack:missing']) {
    await assert.rejects(close(f, marker), status(404));
  }
  for (const size of ['0', '-1', '101']) await assert.rejects(close(f, `trade:${own.id}`, size), status(409));
  assert.equal(f.closes.length, 0);
  assert.equal(f.orders().length, 0);
  assert.equal(f.repo.trades.get(own.id)!.size, '100');
});

test('whole-position partial close distributes confirmed quantity without closing independent lots', async () => {
  const f = await ownFixture();
  const a = await f.ownOpen('perpl', [f.cultA], 100);
  const b = await f.ownOpen('perpl', [f.cultB], 200);
  f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '120', size: 120, notionalAusd: 120 });
  await close(f);
  assert.equal(lot(f, a).size, '60');
  assert.equal(lot(f, b).size, '120');
  assert.equal(lot(f, a).closedAt, null);
  assert.equal(lot(f, b).closedAt, null);
  const order = f.orders().at(-1)!;
  await f.engine.bookOwnFill(order.id, fill('perpl', '60'));
  await f.engine.bookOwnFill(order.id, fill('perpl', '120'));
  assert.equal(lot(f, a).size, '60');
  assert.equal(lot(f, b).size, '120');
  await f.engine.bookOwnFill(order.id, fill('perpl', '180'));
  assert.equal(lot(f, a).size, '40');
  assert.equal(lot(f, b).size, '80');
});

test('invalid or missing fills cannot create successful bookkeeping', async () => {
  const f = await ownFixture();
  const order = request(f);
  for (const raw of ['0', '-1']) await assert.rejects(f.engine.bookOwnFill(order.id, fill('perpl', raw)), status(409));
  for (const price of [0, -1, NaN, Infinity]) await assert.rejects(f.engine.bookOwnFill(order.id, fill('perpl', '1', { priceAusd: price })), status(503));
  await assert.rejects(f.engine.bookOwnFill('missing', fill('perpl', '1')), status(404));
  assert.equal(f.repo.trades.get(order.id), null);
  assert.equal(f.memberOrders.get(order.id)!.bookedSize, '0');
  assert.equal(f.repo.mirrors.forTrade(order.id).length, 0);
});

test('opposite Perpl opens are rejected before adapter.open or request creation', async () => {
  const f = await ownFixture();
  f.put(f.user, holding('perpl', '100', { side: 'short' }));
  await assert.rejects(f.ownOpen('perpl', [f.cultA]), status(409));
  assert.equal(f.opens.length, 0);
  assert.equal(f.orders().length, 0);
});

test('simultaneous own requests serialize the side guard against the newly opened holding', async () => {
  const f = await ownFixture();
  const results = await Promise.allSettled([
    f.ownOpen('perpl', []),
    f.engine.executeOwnOpen({ userId: f.user, market: '16', side: 'short', notionalAusd: 10 }, [f.cultA]),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(f.opens.length, 1);
  assert.equal(f.orders().length, 1);
});

test('ordinary members and outsiders cannot post own opens to a cult they do not administer', async () => {
  const f = await ownFixture();
  for (const userId of [f.shared, f.stranger]) {
    await assert.rejects(f.engine.executeOwnOpen({ userId, market: '16', side: 'long', notionalAusd: 10 }, [f.cultA]), status(403));
  }
  assert.equal(f.opens.length, 0);
  assert.equal(f.orders(f.shared).length, 0);
  assert.equal(f.orders(f.stranger).length, 0);
});

test('unknown holdings never imply that an own lot, copy or stack has closed', async () => {
  const f = await ownFixture();
  const own = f.seedTrade('100');
  const leader = f.seedTrade('100', { userId: f.shared });
  const mirror = f.seedMirror(leader, '100');
  const stack = f.seedStack(leader, '100');
  f.controls.holdingsError = new Error('offline balance unavailable');
  await assert.rejects(close(f, `trade:${own.id}`), /balance unavailable/);
  assert.equal(f.repo.trades.get(own.id)!.closedAt, null);
  assert.equal(f.repo.mirrors.get(mirror.id)!.status, 'open');
  assert.equal(f.getDb().prepare('SELECT status FROM stacks WHERE id = ?').get(stack)!.status, 'open');
  assert.equal(f.closes.length, 0);
});

test('an external decrease scales every own lot and preserves a nonzero remainder below 1%', async () => {
  const f = await ownFixture();
  const a = await f.ownOpen('perpl', [], 10000);
  const b = await f.ownOpen('perpl', [], 20000);
  const session = f.sessions.get(f.user)!;
  session.positions.set(`${f.members.get(f.user)!.perplAccountId!}:16`, position(f, 30000));
  session.emit('ready');
  f.put(f.user, holding('perpl', '3'));
  session.emit('position', position(f, 3));
  await flush();
  assert.equal(lot(f, a).size, '1');
  assert.equal(lot(f, b).size, '2');
  assert.equal(lot(f, a).closedAt, null);
  assert.equal(lot(f, b).closedAt, null);
  session.emit('position', position(f, 3));
  await flush();
  assert.equal(lot(f, a).size, '1', 'repeated cumulative position snapshots do not shrink twice');
});

test('a scoped own close position event cannot close other lots before its fill is booked', async () => {
  const f = await ownFixture();
  const a = await f.ownOpen('perpl', [], 100);
  const b = await f.ownOpen('perpl', [f.cultB], 100);
  const session = f.sessions.get(f.user)!;
  f.controls.close = async (_input, proposed) => {
    session.emit('positionClosed', { ...position(f, 200, proposed.requestId), st: PositionStatus.Closed });
    await flush();
    assert.equal(lot(f, a).closedAt, null);
    assert.equal(lot(f, b).closedAt, null);
    return proposed;
  };
  await close(f, a.markerId);
  assert.ok(lot(f, a).closedAt);
  assert.equal(lot(f, b).size, '100');
  assert.equal(lot(f, b).closedAt, null);
});

test('websocket cumulative order fill and HTTP result create one lot with the same request audience', async () => {
  const f = await ownFixture();
  const session = f.sessions.get(f.user)!;
  f.controls.open = async (_input, proposed) => {
    session.emit('order', { acc: f.members.get(f.user)!.perplAccountId!, rq: proposed.requestId,
      oid: proposed.orderId, mkt: 16, fs: 40, fp: 1, st: OrderStatus.PartiallyFilled });
    await flush();
    return proposed;
  };
  const result = await f.ownOpen('perpl', [f.cultA]);
  await flush();
  assert.equal(lot(f, result).size, '100');
  assert.equal(f.memberOrders.get(result.tradeId!)!.bookedSize, '100');
  assert.deepEqual(lot(f, result).cultIds, [f.cultA]);
  assert.equal(f.repo.mirrors.forTrade(result.tradeId!).filter(m => m.userId === f.shared).length, 1);
});

test('member-order refs remain isolated by account and survive case-insensitive tx lookup', async () => {
  const f = await ownFixture();
  const a = request(f, 'perpl', [f.cultA]);
  const b = request(f, 'perpl', [f.cultB]);
  f.memberOrders.ref(a.id, { accountId: 100, rq: 9 });
  f.memberOrders.ref(b.id, { accountId: 200, rq: 9 });
  assert.equal(f.memberOrders.perpl(100, 9)!.id, a.id);
  assert.equal(f.memberOrders.perpl(200, 9)!.id, b.id);
  f.memberOrders.ref(a.id, { txHash: '0xAbCd' });
  assert.equal(f.memberOrders.tx('0xaBcD')!.id, a.id);
  assert.equal(f.memberOrders.get(a.id)!.accountId, 100);
  assert.equal(f.memberOrders.get(a.id)!.rq, 9);
});
