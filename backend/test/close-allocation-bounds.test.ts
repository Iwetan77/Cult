import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { MirrorEngine } from '../src/mirror/engine.js';
import type { LeaderTrade, Mirror } from '../src/mirror/repo.js';
import type { Venue } from '../src/venues/types.js';
import { fill, holding, installOfflineFetch, marketFor, ownFixture, sideFor, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

before(installOfflineFetch);
afterEach(stopFixtures);
after(verifyOffline);

const exits = (engine: MirrorEngine) => engine as unknown as {
  closeMirror(mirror: Mirror, trade: LeaderTrade): Promise<void>;
  runAdjustment(id: string): Promise<void>;
};

async function fixture(venue: Venue, kind: 'trade' | 'mirror' | 'stack', raw = '100') {
  const f = await ownFixture();
  const privateLot = f.seedTrade(raw, { venue, market: marketFor(venue), side: sideFor(venue), cultIds: [] });
  const trade = f.seedTrade(raw, { venue, market: marketFor(venue), side: sideFor(venue),
    userId: kind === 'trade' ? f.user : f.stranger });
  const mirror = kind === 'mirror' ? f.seedMirror(trade, raw) : null;
  const stack = kind === 'stack' ? f.seedStack(trade, raw) : null;
  const marker = kind === 'trade' ? 'trade:' + trade.id : kind === 'mirror' ? 'mirror:' + mirror!.id : 'stack:' + stack;
  const target = () => kind === 'trade' ? f.repo.trades.get(trade.id)!
    : kind === 'mirror' ? f.repo.mirrors.get(mirror!.id)!
    : f.getDb().prepare('SELECT size, status FROM stacks WHERE id = ?').get(stack!) as { size: string; status: string };
  const closed = () => kind === 'trade' ? !!f.repo.trades.get(trade.id)!.closedAt : (target() as { status: string }).status === 'closed';
  return { ...f, privateLot, trade, mirror, stack, marker, target, closed };
}

for (const venue of ['perpl', 'nadfun'] as const) {
  for (const kind of ['trade', 'mirror', 'stack'] as const) {
    test(`${venue}: selected ${kind} close sends its live allocated bound and fully retires the logical target`, async () => {
      const f = await fixture(venue, kind);
      f.put(f.user, holding(venue, '100'));
      const available = f.allocatedHoldings(f.user, await f.adapters[venue].holdings(f.user));
      assert.equal(available.find(part => part.markerId === f.marker)!.sizeRaw, '50');
      await f.engine.executeOwnClose({ userId: f.user, market: marketFor(venue) }, f.marker);
      assert.equal(f.closes[0].sizeRaw, '50', 'never request the stale recorded quantity of 100');
      assert.ok(f.closed(), 'closing all 50 available must retire the entire recorded target, not leave a phantom 50');
      assert.equal(f.repo.trades.get(f.privateLot.id)!.size, '100');
      assert.equal(f.repo.trades.get(f.privateLot.id)!.closedAt, null);
      const after = f.allocatedHoldings(f.user, await f.adapters[venue].holdings(f.user));
      assert.equal(after.length, 1);
      assert.equal(after[0].markerId, 'trade:' + f.privateLot.id);
      assert.equal(after[0].sizeRaw, '50');
    });

    test(`${venue}: partial ${kind} close applies the live-to-recorded ratio once and preserves neighboring private balance`, async () => {
      const f = await fixture(venue, kind);
      f.put(f.user, holding(venue, '100'));
      f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '25', size: 25, notionalAusd: 25 });
      await f.engine.executeOwnClose({ userId: f.user, market: marketFor(venue) }, f.marker);
      assert.equal(f.closes[0].sizeRaw, '50');
      assert.equal(f.target().size, '50', 'half the available slice corresponds to half the recorded target');
      assert.equal(f.closed(), false);
      const request = f.orders().find(order => order.kind === 'close')!;
      await f.makeEngine().bookOwnFill(request.id, fill(venue, '25'));
      await f.makeEngine().bookOwnFill(request.id, fill(venue, '10'));
      assert.equal(f.target().size, '50');
      const afterPartial = f.allocatedHoldings(f.user, await f.adapters[venue].holdings(f.user));
      assert.equal(afterPartial.find(part => part.markerId === f.marker)!.sizeRaw, '25');
      assert.equal(afterPartial.find(part => part.markerId === 'trade:' + f.privateLot.id)!.sizeRaw, '50');
      f.put(f.user, holding(venue, '50'));
      await f.makeEngine().bookOwnFill(request.id, fill(venue, '50'));
      assert.ok(f.closed());
      assert.equal(f.repo.trades.get(f.privateLot.id)!.closedAt, null);
      assert.equal(f.repo.trades.get(f.privateLot.id)!.size, '100');
      assert.equal(f.closes.length, 1, 'cumulative bookings never resend the close');
    });
  }

  test(`${venue}: an automatic copy exit uses only the live copy slice instead of selling its private neighbor`, async () => {
    const f = await fixture(venue, 'mirror');
    f.put(f.user, holding(venue, '100'));
    f.repo.trades.markClosed(f.trade.id);
    await exits(f.engine).closeMirror(f.mirror!, f.repo.trades.get(f.trade.id)!);
    assert.equal(f.closes[0].sizeRaw, '50');
    assert.ok(f.closed());
    assert.equal(f.target().size, '100', 'fully closed mirrors retain their last logical size');
    const left = f.allocatedHoldings(f.user, await f.adapters[venue].holdings(f.user));
    assert.equal(left.length, 1);
    assert.equal(left[0].markerId, 'trade:' + f.privateLot.id);
    assert.equal(left[0].sizeRaw, '50');
  });

  test(`${venue}: a partial automatic exit scales the logical copy residual to the filled live slice`, async () => {
    const f = await fixture(venue, 'mirror');
    f.put(f.user, holding(venue, '100'));
    f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '25', size: 25, notionalAusd: 25 });
    f.repo.trades.markClosed(f.trade.id);
    await exits(f.engine).closeMirror(f.mirror!, f.repo.trades.get(f.trade.id)!);
    assert.equal(f.closes[0].sizeRaw, '50');
    assert.equal(f.target().size, '50');
    assert.equal(f.closed(), false);
    const after = f.allocatedHoldings(f.user, await f.adapters[venue].holdings(f.user));
    assert.equal(after.find(part => part.markerId === f.marker)!.sizeRaw, '25');
    assert.equal(after.find(part => part.markerId === 'trade:' + f.privateLot.id)!.sizeRaw, '50');
  });

  test(`${venue}: a follower partial reduction sells its live slice proportion and books the matching logical reduction`, async () => {
    const f = await fixture(venue, 'mirror');
    f.put(f.user, holding(venue, '100'));
    await f.engine.leaderResized(f.trade, 50n, 1, undefined, true);
    const adjustment = f.repo.adjustments.forMirror(f.mirror!.id)[0];
    await exits(f.engine).runAdjustment(adjustment.id);
    assert.equal(f.closes[0].sizeRaw, '25', 'half the 50-unit live copy slice, not half the stale 100-unit record');
    assert.equal(f.target().size, '50');
    assert.equal(f.closed(), false);
    assert.equal(f.repo.adjustments.get(adjustment.id)!.status, 'done');
    const after = f.allocatedHoldings(f.user, await f.adapters[venue].holdings(f.user));
    assert.equal(after.find(part => part.markerId === f.marker)!.sizeRaw, '25');
    assert.equal(after.find(part => part.markerId === 'trade:' + f.privateLot.id)!.sizeRaw, '50');
  });
}

test('stale opposite-side copies cannot borrow a current private short position for an automatic exit', async () => {
  const f = await ownFixture();
  const privateShort = f.seedTrade('100', { side: 'short', cultIds: [] });
  const oldLong = f.seedTrade('100', { userId: f.stranger, side: 'long' });
  const mirror = f.seedMirror(oldLong, '100');
  f.put(f.user, holding('perpl', '100', { side: 'short' }));
  f.repo.trades.markClosed(oldLong.id);
  await exits(f.engine).closeMirror(mirror, f.repo.trades.get(oldLong.id)!);
  assert.deepEqual(f.closes, [], 'there is no live long slice for this copy to close');
  assert.equal(f.repo.mirrors.get(mirror.id)!.closeOid, null);
  assert.equal(f.repo.mirrors.get(mirror.id)!.closeTx, null);
  const after = f.allocatedHoldings(f.user, await f.adapters.perpl.holdings(f.user));
  assert.equal(after.length, 1);
  assert.equal(after[0].markerId, 'trade:' + privateShort.id);
  assert.equal(after[0].sizeRaw, '100');
  assert.equal(f.repo.trades.get(privateShort.id)!.closedAt, null);
});
