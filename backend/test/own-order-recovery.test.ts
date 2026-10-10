import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fill, holding, installOfflineFetch, ownFixture, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

before(installOfflineFetch);
afterEach(stopFixtures);
after(verifyOffline);

test('a later cumulative open fill after a full lot close remains allocated and booked', async () => {
  const f = await ownFixture();
  f.controls.open = (_input, proposed) => ({ ...proposed, sizeRaw: '40', size: 40, notionalAusd: 40 });
  const opened = await f.ownOpen('perpl', [f.cultA]);
  await f.engine.executeOwnClose({ userId: f.user, market: '16' }, opened.markerId);
  assert.ok(f.repo.trades.get(opened.tradeId!)!.closedAt);
  f.put(f.user, holding('perpl', '60'));
  const resumed = f.makeEngine();
  await resumed.bookOwnFill(opened.tradeId!, fill('perpl', '100', { requestId: opened.requestId, priceAusd: 2, notionalAusd: 200 }));
  const remaining = f.repo.trades.openOnMarket(f.user, 'perpl', '16');
  assert.equal(remaining.reduce((sum, lot) => sum + BigInt(lot.size), 0n), 60n,
    '100 confirmed open minus 40 confirmed close must leave 60 tracked, not an unattributed balance');
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0].id, opened.tradeId, 'never revive the closed shared lot');
  assert.deepEqual(remaining[0].cultIds, [], 'the late residual is private, not another shared copy signal');
  assert.ok(Math.abs(remaining[0].entryPrice! - 160 / 60) < 1e-10, 'entry uses only the incremental fill cost');
  assert.ok(f.repo.trades.get(opened.tradeId!)!.closedAt);
  assert.ok(f.repo.mirrors.forTrade(opened.tradeId!).every(mirror => mirror.status === 'cancelled'));
  assert.deepEqual(f.repo.mirrors.forTrade(remaining[0].id), []);
  assert.equal(f.memberOrders.get(opened.tradeId!)!.bookedSize, '100');
  const checkpoint = f.memberOrders.get(opened.tradeId!) as unknown as { allocationId: string; bookedNotional: number };
  assert.equal(checkpoint.allocationId, remaining[0].id);
  assert.equal(checkpoint.bookedNotional, 200);
  const positions = f.allocatedHoldings(f.user, await f.adapters.perpl.holdings(f.user, ['16']));
  assert.equal(positions[0].markerId, 'trade:' + remaining[0].id);
  assert.equal(positions[0].origin, 'private');
  assert.equal(positions[0].sizeRaw, '60');
  await resumed.bookOwnFill(opened.tradeId!, fill('perpl', '100', { priceAusd: 2, notionalAusd: 200 }));
  await resumed.bookOwnFill(opened.tradeId!, fill('perpl', '40'));
  assert.equal(f.repo.trades.openOnMarket(f.user, 'perpl', '16').reduce((sum, lot) => sum + BigInt(lot.size), 0n), 60n);
  assert.equal(f.opens.length, 1, 'recovery must never resubmit an own order');
});

test('a later cumulative open fill after a partial lot close adds only the unbooked quantity', async () => {
  const f = await ownFixture();
  f.controls.open = (_input, proposed) => ({ ...proposed, sizeRaw: '40', size: 40, notionalAusd: 40 });
  const opened = await f.ownOpen();
  await f.engine.executeOwnClose({ userId: f.user, market: '16', sizeRaw: '10' }, opened.markerId);
  await f.engine.bookOwnFill(opened.tradeId!, fill('perpl', '100', { priceAusd: 2, notionalAusd: 200 }));
  assert.equal(f.repo.trades.get(opened.tradeId!)!.size, '90');
  assert.equal(f.repo.trades.get(opened.tradeId!)!.closedAt, null);
  assert.equal(f.memberOrders.get(opened.tradeId!)!.bookedSize, '100');
  assert.ok(Math.abs(f.repo.trades.get(opened.tradeId!)!.entryPrice! - 190 / 90) < 1e-10,
    '30 remaining at $1 plus 60 new for $160 must not use the original cumulative average');
});

test('an HTTP open result identifies the latest private allocation when an earlier partial lot closed', async () => {
  const f = await ownFixture();
  let originalId = '';
  f.controls.open = async (_input, proposed) => {
    originalId = f.orders()[0].id;
    await f.engine.bookOwnFill(originalId, fill('perpl', '40', { requestId: proposed.requestId }));
    await f.engine.closeTrade(f.repo.trades.get(originalId)!);
    return { ...proposed, sizeRaw: '100', size: 100, priceAusd: 2, notionalAusd: 200 };
  };
  const result = await f.ownOpen('perpl', [f.cultA]);
  assert.notEqual(result.tradeId, originalId);
  assert.equal(result.markerId, 'trade:' + result.tradeId);
  assert.ok(f.repo.trades.get(originalId)!.closedAt);
  assert.equal(f.repo.trades.get(result.tradeId!)!.size, '60');
  assert.deepEqual(f.repo.trades.get(result.tradeId!)!.cultIds, []);
});

test('first-lot insertion and its booked checkpoint survive interruption before follower work', async () => {
  const f = await ownFixture();
  f.engine.once('trade', () => { throw new Error('offline interruption after lot insertion'); });
  await assert.rejects(f.ownOpen(), /offline interruption/);
  const request = f.orders()[0];
  assert.equal(request.bookedSize, '100');
  assert.equal(request.state, 'filled');
  assert.equal(f.repo.trades.get(request.id)!.size, '100');
  await f.makeEngine().bookOwnFill(request.id, fill('perpl', '100'));
  assert.equal(f.repo.trades.openOnMarket(f.user, 'perpl', '16').length, 1);
  assert.equal(f.repo.trades.get(request.id)!.size, '100');
  assert.equal(f.opens.length, 1);
});

test('a synchronous cumulative resize failure rolls back quantity and checkpoint together before replay', async () => {
  const f = await ownFixture();
  f.controls.open = (_input, proposed) => ({ ...proposed, sizeRaw: '40', size: 40, notionalAusd: 40 });
  const opened = await f.ownOpen();
  f.engine.once('tradeChanged', () => { throw new Error('offline interruption after resize'); });
  await assert.rejects(f.engine.bookOwnFill(opened.tradeId!, fill('perpl', '100')), /offline interruption/);
  assert.equal(f.repo.trades.get(opened.tradeId!)!.size, '40');
  assert.equal(f.memberOrders.get(opened.tradeId!)!.bookedSize, '40');
  await f.makeEngine().bookOwnFill(opened.tradeId!, fill('perpl', '100'));
  assert.equal(f.repo.trades.get(opened.tradeId!)!.size, '100');
});

test('a synchronous partial close failure rolls back its target before replaying the confirmed fill', async () => {
  const f = await ownFixture();
  const opened = await f.ownOpen();
  f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '40', size: 40, notionalAusd: 40 });
  f.engine.once('tradeChanged', () => { throw new Error('offline interruption after target reduction'); });
  await assert.rejects(f.engine.executeOwnClose({ userId: f.user, market: '16' }, opened.markerId), /offline interruption/);
  const request = f.orders().find(order => order.kind === 'close')!;
  assert.equal(f.repo.trades.get(opened.tradeId!)!.size, '100');
  assert.equal(f.memberOrders.get(request.id)!.bookedSize, '0');
  await f.makeEngine().bookOwnFill(request.id, fill('perpl', '40'));
  assert.equal(f.repo.trades.get(opened.tradeId!)!.size, '60');
  assert.equal(f.memberOrders.get(request.id)!.bookedSize, '40');
  assert.equal(f.closes.length, 1);
});

test('an interrupted whole-position close resumes unapplied targets without reducing earlier targets twice', async () => {
  const f = await ownFixture();
  const first = await f.ownOpen();
  const second = await f.ownOpen();
  f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '80', size: 80, notionalAusd: 80 });
  f.engine.once('tradeChanged', () => { throw new Error('offline interruption between targets'); });
  await assert.rejects(f.engine.executeOwnClose({ userId: f.user, market: '16' }), /offline interruption/);
  const request = f.orders().find(order => order.kind === 'close')!;
  await f.makeEngine().bookOwnFill(request.id, fill('perpl', '80'));
  for (const opened of [first, second]) {
    assert.equal(f.repo.trades.get(opened.tradeId!)!.size, '60');
    assert.equal(f.repo.trades.get(opened.tradeId!)!.closedAt, null);
  }
  assert.equal(f.memberOrders.get(request.id)!.bookedSize, '80');
  assert.equal(f.closes.length, 1);
});

test('an interrupted full close replays without closing or reducing a different lot', async () => {
  const f = await ownFixture();
  const target = await f.ownOpen();
  const other = await f.ownOpen('perpl', [f.cultB], 50);
  f.engine.once('tradeClosed', () => { throw new Error('offline interruption after full close'); });
  await assert.rejects(f.engine.executeOwnClose({ userId: f.user, market: '16' }, target.markerId), /offline interruption/);
  const request = f.orders().find(order => order.kind === 'close')!;
  await f.makeEngine().bookOwnFill(request.id, fill('perpl', '100'));
  assert.ok(f.repo.trades.get(target.tradeId!)!.closedAt);
  assert.equal(f.repo.trades.get(other.tradeId!)!.size, '50');
  assert.equal(f.repo.trades.get(other.tradeId!)!.closedAt, null);
  assert.equal(f.memberOrders.get(request.id)!.bookedSize, '100');
  assert.equal(f.closes.length, 1);
});

test('a stale persisted open fill is tracked but does not send or schedule stale automatic copies', async () => {
  const f = await ownFixture();
  const request = f.memberOrders.begin({ userId: f.user, venue: 'perpl', market: '16', kind: 'open', side: 'long',
    leverage: 200, marginFraction: 0.1, cultIds: [f.cultA], markerId: null, requestedNotional: 100 });
  f.getDb().prepare('UPDATE member_orders SET created_at = ? WHERE id = ?').run(Date.now() - 121000, request.id);
  await f.makeEngine().bookOwnFill(request.id, fill('perpl', '100'));
  assert.equal(f.repo.trades.get(request.id)!.size, '100');
  assert.deepEqual(f.repo.trades.get(request.id)!.cultIds, [f.cultA]);
  assert.equal(f.memberOrders.get(request.id)!.bookedSize, '100');
  assert.equal(f.repo.mirrors.forTrade(request.id).length, 2);
  assert.ok(f.repo.mirrors.forTrade(request.id).every(mirror => mirror.status === 'cancelled'));
  assert.deepEqual(f.opens, []);
});

test('a confirmed spot sale retains its request identity after approval and follow-up swap references', async () => {
  const f = await ownFixture();
  const privateLot = await f.ownOpen('nadfun', [], 100);
  const sharedLot = await f.ownOpen('nadfun', [f.cultA], 100);
  const request = f.memberOrders.begin({ userId: f.user, venue: 'nadfun', market: f.repo.trades.get(sharedLot.tradeId!)!.market,
    kind: 'close', side: 'buy', leverage: 100, marginFraction: 0, cultIds: [], markerId: sharedLot.markerId!,
    requestedNotional: 0, beforeSize: '100', targets: [{ markerId: sharedLot.markerId!, size: '100' }] });
  for (const txHash of ['0xapprove', '0xSale', '0xswap']) f.memberOrders.ref(request.id, { txHash });
  for (const txHash of ['0xapprove', '0xsale', '0xSWAP']) assert.equal(f.memberOrders.tx(txHash)!.id, request.id);
  assert.equal(f.memberOrders.get(request.id)!.txHash, '0xswap', 'the last ref remains a useful progress checkpoint');
  f.put(f.user, holding('nadfun', '100'));
  await f.makeEngine().bookOwnFill(f.memberOrders.tx('0xsale')!.id, fill('nadfun', '100', { txHash: '0xsale' }));
  assert.ok(f.repo.trades.get(sharedLot.tradeId!)!.closedAt);
  assert.equal(f.repo.trades.get(privateLot.tradeId!)!.closedAt, null);
  assert.equal(f.repo.trades.get(privateLot.tradeId!)!.size, '100');
  assert.deepEqual(f.closes, [], 'recovery only books the confirmed sale');
});
