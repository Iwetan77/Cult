import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installOfflineFetch, marketFor, ownFixture, sideFor, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

before(installOfflineFetch);
afterEach(stopFixtures);
after(verifyOffline);

// The live position feed reporting an opening the member's own order already
// booked (same on-chain tx), as happened on 2026-10-14: one SOL open became
// two trades and both followers were copied twice.
const feedSaw = (f: Awaited<ReturnType<typeof ownFixture>>, openTx: string, sizeRaw = '100') =>
  f.engine.leaderOpened({ venue: 'perpl', userId: f.user, market: marketFor('perpl'), side: sideFor('perpl') as 'long',
    sizeRaw, entryPriceAusd: 1, leverageHundredths: 300, marginFraction: 0.1, accountId: f.members.get(f.user)!.perplAccountId!, positionId: 701, openTx });

test('own order booked first: the position feed seeing the same opening makes no second trade or copies', async () => {
  const f = await ownFixture();
  const opened = await f.ownOpen('perpl', [f.cultA]);
  const first = f.repo.trades.get(opened.tradeId!)!;
  const copiesBefore = f.repo.mirrors.forTrade(first.id).length;
  assert.ok(copiesBefore > 0, 'followers copy the trade once');
  const again = await feedSaw(f, first.openTx!);
  assert.equal(again?.id, first.id, 'the same trade, not a new one');
  const open = f.repo.trades.openOnMarket(f.user, 'perpl', marketFor('perpl'));
  assert.equal(open.length, 1);
  assert.equal(f.repo.mirrors.forTrade(first.id).length, copiesBefore, 'no second round of copies');
});

test('position feed first: the own order adopts that trade instead of making another', async () => {
  const f = await ownFixture();
  // The fixture's fake venue fills with tx = rq in hex; predict the next one.
  const order = f.memberOrders.begin({ userId: f.user, venue: 'perpl', market: marketFor('perpl'), kind: 'open', side: sideFor('perpl') as 'long',
    leverage: 300, marginFraction: 0.1, cultIds: [f.cultA], markerId: null, requestedNotional: 100 });
  const tx = '0x' + 'ab'.repeat(32);
  const fromFeed = await feedSaw(f, tx);
  assert.ok(fromFeed);
  await f.engine.bookOwnFill(order.id, { venue: 'perpl', market: marketFor('perpl'), side: sideFor('perpl') as 'long', sizeRaw: '100', size: 1, priceAusd: 1, notionalAusd: 1, txHash: tx });
  assert.equal(f.repo.trades.openOnMarket(f.user, 'perpl', marketFor('perpl')).length, 1, 'one trade for one opening');
  assert.equal(f.memberOrders.get(order.id)!.allocationId, fromFeed!.id, 'the order owns the trade the feed made');
});

test('two of the member\'s own orders batched into one Perpl tx stay two lots', async () => {
  const f = await ownFixture();
  const tx = '0x' + 'cd'.repeat(32);
  const lots = [];
  for (const n of [1, 2]) {
    const order = f.memberOrders.begin({ userId: f.user, venue: 'perpl', market: marketFor('perpl'), kind: 'open', side: sideFor('perpl') as 'long',
      leverage: 300, marginFraction: 0.1, cultIds: [f.cultA], markerId: null, requestedNotional: 100 * n });
    await f.engine.bookOwnFill(order.id, { venue: 'perpl', market: marketFor('perpl'), side: sideFor('perpl') as 'long', sizeRaw: String(100 * n), size: n, priceAusd: 1, notionalAusd: n, txHash: tx });
    lots.push(f.memberOrders.get(order.id)!.allocationId);
  }
  assert.notEqual(lots[0], lots[1]);
  assert.equal(f.repo.trades.openOnMarket(f.user, 'perpl', marketFor('perpl')).length, 2);
});
