import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { MirrorEngine } from '../src/mirror/engine.js';
import type { LeaderTrade, Mirror } from '../src/mirror/repo.js';
import type { Landed } from '../src/mirror/reconcile.js';
import type { Venue } from '../src/venues/types.js';
import { fill, flush, holding, installOfflineFetch, marketFor, ownFixture, sideFor, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

before(installOfflineFetch);
afterEach(stopFixtures);
after(verifyOffline);

// Exercise recovery directly; no engine.start(), watchers or live workers.
const exits = (engine: MirrorEngine) => engine as unknown as {
  closeMirror(mirror: Mirror, trade: LeaderTrade): Promise<void>;
  reconcileExit(id: string): Promise<void>;
  runAdjustment(id: string): Promise<void>;
  reconcileAdjustment(id: string): Promise<void>;
};

async function fixture(venue: Venue = 'perpl', raw = '100') {
  const f = await ownFixture();
  const trade = f.seedTrade(raw, { userId: f.stranger, venue, market: marketFor(venue), side: sideFor(venue),
    accountId: venue === 'perpl' ? f.members.get(f.stranger)!.perplAccountId : null });
  const mirror = f.seedMirror(trade, raw);
  f.put(f.user, holding(venue, raw));
  f.repo.trades.markClosed(trade.id);
  return { ...f, trade: f.repo.trades.get(trade.id)!, mirror };
}

for (const venue of ['perpl', 'nadfun'] as const) {
  test(`${venue}: a full automatic exit with a partial fill preserves even a sub-1% residual`, async () => {
    const f = await fixture(venue, '10000');
    const notices: Mirror[] = [];
    f.engine.on('mirror', mirror => notices.push(mirror));
    f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '9999', size: 9999, notionalAusd: 9999 });
    await exits(f.engine).closeMirror(f.mirror, f.trade);
    const partial = f.repo.mirrors.get(f.mirror.id)!;
    assert.equal(partial.status, 'open');
    assert.equal(partial.size, '1');
    assert.equal(partial.notionalUsd, 1);
    assert.equal(f.closes[0].sizeRaw, '10000');
    assert.equal(f.closes[0].side, sideFor(venue));
    assert.ok(notices.every(mirror => mirror.status !== 'closed'));
    delete f.controls.close;
    await exits(f.engine).closeMirror(partial, f.trade);
    const closed = f.repo.mirrors.get(f.mirror.id)!;
    assert.equal(closed.status, 'closed');
    assert.equal(closed.size, '1', 'closed mirrors retain their last confirmed size');
    assert.equal(f.closes[1].sizeRaw, '1');
    assert.equal(notices.filter(mirror => mirror.status === 'closed').length, 1);
  });

  test(`${venue}: rejected and zero-filled automatic exits never claim a confirmed close`, async t => {
    for (const outcome of ['rejected', 'zero'] as const) {
      await t.test(outcome, async () => {
        const f = await fixture(venue);
        const snapshots: Mirror[] = [];
        f.engine.on('mirror', mirror => snapshots.push(mirror));
        f.controls.close = (_input, proposed) => {
          if (outcome === 'rejected') throw new Error('offline rejected exit');
          return { ...proposed, sizeRaw: '0', size: 0, notionalAusd: 0 };
        };
        await exits(f.engine).closeMirror(f.mirror, f.trade);
        const now = f.repo.mirrors.get(f.mirror.id)!;
        assert.equal(now.status, 'open');
        assert.equal(now.size, '100');
        assert.equal(now.closeOid, null);
        assert.equal(now.closeTx, null);
        assert.match(now.error!, /close failed/);
        assert.ok(snapshots.every(mirror => mirror.status !== 'closed'));
        assert.equal((await f.adapters[venue].holdings(f.user))[0].sizeRaw, '100');
      });
    }
  });

  test(`${venue}: unknown holdings plus a failed exit leave the copy unconfirmed and open`, async () => {
    const f = await fixture(venue);
    f.controls.holdingsError = new Error('offline balance unavailable');
    f.controls.close = () => { throw new Error('offline exit unavailable'); };
    await exits(f.engine).closeMirror(f.mirror, f.trade);
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'open');
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.size, '100');
    assert.match(f.repo.mirrors.get(f.mirror.id)!.error!, /close failed/);
  });

  test(`${venue}: a verified empty holding records an already-exited member without sending another close`, async () => {
    const f = await fixture(venue);
    f.put(f.user, holding(venue, '0'));
    await exits(f.engine).closeMirror(f.mirror, f.trade);
    const closed = f.repo.mirrors.get(f.mirror.id)!;
    assert.equal(closed.status, 'closed');
    assert.equal(closed.closeOid, null);
    assert.equal(closed.closeTx, null);
    assert.match(closed.error!, /member had already exited/);
    assert.deepEqual(f.closes, []);
  });

  test(`${venue}: duplicate partial exit recovery is idempotent across fresh engine instances`, async () => {
    const f = await fixture(venue);
    const result: Landed = { state: 'filled', sizeRaw: '40', notionalUsd: 40,
      orderId: venue === 'perpl' ? 700 : null, txHash: venue === 'nadfun' ? '0xpartial-exit' : null };
    const make = () => f.makeEngine(async (v, kind, id, userId) => {
      assert.equal(v, venue); assert.equal(kind, 'mirror_close');
      assert.equal(id, f.mirror.id); assert.equal(userId, f.user);
      return result;
    });
    await exits(make()).reconcileExit(f.mirror.id);
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.size, '60');
    await exits(make()).reconcileExit(f.mirror.id);
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.size, '60');
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'open');
    assert.deepEqual(f.closes, []);
  });

  test(`${venue}: a second distinct recovered exit consumes only the residual and retains final last-size semantics`, async () => {
    const f = await fixture(venue);
    let result: Landed = { state: 'filled', sizeRaw: '40', notionalUsd: 40, orderId: 701, txHash: '0xexit-one' };
    const engine = f.makeEngine(async () => result);
    await exits(engine).reconcileExit(f.mirror.id);
    result = { state: 'filled', sizeRaw: '60', notionalUsd: 60, orderId: 702, txHash: '0xexit-two' };
    await exits(engine).reconcileExit(f.mirror.id);
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'closed');
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.size, '60');
    assert.deepEqual(f.closes, []);
  });
}

test('zero-filled automatic opens never produce an open mirror snapshot', async () => {
  const f = await ownFixture();
  const opened = await f.ownOpen('perpl', [f.cultA]);
  const pending = f.repo.mirrors.forTrade(opened.tradeId!)[0];
  const snapshots: Mirror[] = [];
  f.engine.on('mirror', mirror => snapshots.push(mirror));
  f.controls.open = (_input, proposed) => ({ ...proposed, sizeRaw: '0', size: 0, notionalAusd: 0 });
  await f.engine.fire(pending.id);
  assert.notEqual(f.repo.mirrors.get(pending.id)!.status, 'open');
  assert.ok(snapshots.every(mirror => mirror.status !== 'open'));
});

test('a zero-filled automatic add is not booked as a successful adjustment or increased mirror', async () => {
  const f = await ownFixture();
  const trade = f.seedTrade('100');
  const mirror = f.seedMirror(trade, '100');
  const policy = f.clans.membership(f.cultA, f.user)!.policy;
  f.clans.setPolicy(f.cultA, f.user, { ...policy, enabled: true });
  f.put(f.user, holding('perpl', '100'));
  await f.engine.leaderResized(trade, 200n, 1, undefined, true);
  const adjustment = f.repo.adjustments.forMirror(mirror.id)[0];
  f.controls.open = (_input, proposed) => ({ ...proposed, sizeRaw: '0', size: 0, notionalAusd: 0 });
  await exits(f.engine).runAdjustment(adjustment.id);
  assert.notEqual(f.repo.adjustments.get(adjustment.id)!.status, 'done');
  assert.equal(f.repo.mirrors.get(mirror.id)!.size, '100');
  assert.equal(f.repo.mirrors.get(mirror.id)!.notionalUsd, 100);
  assert.equal(f.repo.mirrors.get(mirror.id)!.marginUsd, 50);
  assert.equal(f.repo.mirrors.get(mirror.id)!.status, 'open');
});

test('later cumulative exit recovery on the same Perpl order books only the additional filled quantity', async () => {
  const f = await fixture();
  let result: Landed = { state: 'filled', sizeRaw: '40', notionalUsd: 40, orderId: 703, txHash: null };
  await exits(f.makeEngine(async () => result)).reconcileExit(f.mirror.id);
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.size, '60');
  result = { state: 'filled', sizeRaw: '100', notionalUsd: 100, orderId: 703, txHash: null };
  await exits(f.makeEngine(async () => result)).reconcileExit(f.mirror.id);
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'closed', 'a cumulative final fill must not be mistaken for a duplicate partial result');
  assert.deepEqual(f.closes, []);
});

test('a zero-filled recovered exit does not close or shrink the mirror', async () => {
  const f = await fixture();
  await exits(f.makeEngine(async () => ({ state: 'filled', sizeRaw: '0', notionalUsd: 0, orderId: 704, txHash: null }))).reconcileExit(f.mirror.id);
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'open');
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.size, '100');
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.closeOid, null);
  assert.deepEqual(f.closes, []);
});

test('pending recovered exits do not submit or declare a closed copy', async () => {
  const f = await fixture();
  await exits(f.makeEngine(async () => ({ state: 'pending' }))).reconcileExit(f.mirror.id);
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'open');
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.size, '100');
  assert.deepEqual(f.closes, []);
});

test('an automatic close supplies the original expected side and does not book a rejected opposite-side exit', async () => {
  const f = await fixture();
  f.controls.close = (input) => {
    assert.equal(input.side, 'long', 'automatic close must identify the copy side, not the new net position side');
    f.put(f.user, holding('perpl', '100', { side: 'short' }));
    throw new Error('The position changed direction');
  };
  await exits(f.engine).closeMirror(f.mirror, f.trade);
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'open');
  assert.match(f.repo.mirrors.get(f.mirror.id)!.error!, /changed direction/);
  assert.equal((await f.adapters.perpl.holdings(f.user))[0].side, 'short');
  assert.equal((await f.adapters.perpl.holdings(f.user))[0].sizeRaw, '100');
});

test('manual copy closes reject a marker whose live net holding changed to the opposite side', async () => {
  const f = await fixture();
  f.put(f.user, holding('perpl', '100', { side: 'short' }));
  await assert.rejects(f.engine.executeOwnClose({ userId: f.user, market: '16' }, 'mirror:' + f.mirror.id),
    (error: { status?: number }) => error.status === 404);
  assert.deepEqual(f.closes, []);
  assert.deepEqual(f.orders(), []);
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'open');
});

for (const first of ['automatic', 'manual'] as const) {
  test(`concurrent ${first}-first and other-path full closes send only one exit for the same copy`, { timeout: 5000 }, async () => {
    const f = await fixture();
    const other = f.seedTrade('100', { cultIds: [] });
    f.put(f.user, holding('perpl', '200'));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let block = true;
    f.controls.close = async (_input, proposed) => {
      if (block) { block = false; entered.resolve(); await release.promise; }
      return proposed;
    };
    const manual = () => f.engine.executeOwnClose({ userId: f.user, market: '16' }, 'mirror:' + f.mirror.id)
      .then(() => null, error => error);
    const automatic = () => exits(f.engine).closeMirror(f.mirror, f.trade);
    const firstClose = first === 'automatic' ? automatic() : manual();
    await entered.promise;
    const secondClose = first === 'automatic' ? manual() : automatic();
    await flush();
    const whileBlocked = f.closes.length;
    release.resolve();
    await firstClose;
    await secondClose;
    assert.equal(whileBlocked, 1, 'automatic and manual closes must share the same member/market or marker send lock');
    assert.equal(f.closes.length, 1, 'a stale queued close must recheck the already-closed marker');
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'closed');
    assert.equal((await f.adapters.perpl.holdings(f.user))[0]?.sizeRaw, '100', 'the unrelated own lot must not be sold');
    assert.equal(f.repo.trades.get(other.id)!.closedAt, null);
  });
}

test('a manual close queued behind a partial automatic exit refreshes the remaining marker size', { timeout: 5000 }, async () => {
  const f = await fixture();
  f.seedTrade('100', { cultIds: [] });
  f.put(f.user, holding('perpl', '200'));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  f.controls.close = async (_input, proposed) => {
    if (!first) return proposed;
    first = false; entered.resolve(); await release.promise;
    return { ...proposed, sizeRaw: '40', size: 40, notionalAusd: 40 };
  };
  const automatic = exits(f.engine).closeMirror(f.mirror, f.trade);
  await entered.promise;
  const manual = f.engine.executeOwnClose({ userId: f.user, market: '16' }, 'mirror:' + f.mirror.id);
  await flush();
  release.resolve();
  await automatic;
  await manual;
  assert.deepEqual(f.closes.map(input => input.sizeRaw), ['100', '60'], 'the queued close must use the updated residual, not the original 100');
  assert.equal((await f.adapters.perpl.holdings(f.user))[0]?.sizeRaw, '100');
  assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'closed');
});

for (const venue of ['perpl', 'nadfun'] as const) {
  test(`${venue}: a new automatic exit has a distinct recovery reference and cumulative baseline`, async () => {
    const f = await fixture(venue);
    f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '40', size: 40, notionalAusd: 40 });
    await exits(f.engine).closeMirror(f.mirror, f.trade);
    const first = f.repo.mirrors.get(f.mirror.id)!;
    assert.ok(first.closeRef);
    assert.equal(first.closeBeforeSize, '100');
    assert.equal(first.closeRequestedSize, '100');
    assert.equal(first.closeBookedSize, '40');
    f.controls.close = () => { throw new Error('offline interruption after recording the next request'); };
    await exits(f.engine).closeMirror(first, f.trade);
    const second = f.repo.mirrors.get(f.mirror.id)!;
    assert.ok(second.closeRef);
    assert.notEqual(second.closeRef, first.closeRef);
    assert.equal(second.closeBeforeSize, '60');
    assert.equal(second.closeRequestedSize, '60');
    assert.equal(second.closeBookedSize, '0');
    const engine = f.makeEngine(async (_venue, kind, refId) => {
      assert.equal(kind, 'mirror_close');
      assert.equal(refId, second.closeRef, 'never select the previous partially filled attempt');
      return { state: 'filled', sizeRaw: '60', notionalUsd: 60, orderId: 9000, txHash: '0xlatest-exit' };
    });
    await exits(engine).reconcileExit(f.mirror.id);
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'closed');
    assert.equal(f.closes.length, 2, 'recovery books a fill, never resends it');
  });

  test(`${venue}: recovery preserves a clamped live exit ratio and books a later cumulative fill once`, async () => {
    const f = await fixture(venue);
    f.seedTrade('100', { venue, market: marketFor(venue), side: sideFor(venue), cultIds: [] });
    f.put(f.user, holding(venue, '100'));
    f.controls.close = (_input, proposed) => ({ ...proposed, sizeRaw: '25', size: 25, notionalAusd: 25 });
    await exits(f.engine).closeMirror(f.mirror, f.trade);
    const partial = f.repo.mirrors.get(f.mirror.id)!;
    assert.equal(partial.size, '50');
    assert.equal(partial.closeRequestedSize, '50');
    assert.equal(partial.closeBeforeSize, '100');
    assert.equal(partial.closeBookedSize, '25');
    const engine = f.makeEngine(async () => ({ state: 'filled', sizeRaw: '50', notionalUsd: 50,
      orderId: partial.closeOid, txHash: partial.closeTx }));
    await exits(engine).reconcileExit(f.mirror.id);
    await exits(engine).reconcileExit(f.mirror.id);
    assert.equal(f.repo.mirrors.get(f.mirror.id)!.status, 'closed');
    assert.equal(f.closes.length, 1);
  });

  test(`${venue}: interrupted follower partial exits retain their live-to-recorded ratio`, async () => {
    const f = await ownFixture();
    const leader = f.seedTrade('100', { venue, market: marketFor(venue), side: sideFor(venue), userId: f.stranger });
    const mirror = f.seedMirror(leader, '100');
    f.seedTrade('100', { venue, market: marketFor(venue), side: sideFor(venue), cultIds: [] });
    f.put(f.user, holding(venue, '100'));
    await f.engine.leaderResized(leader, 50n, 1, undefined, true);
    const adjustment = f.repo.adjustments.forMirror(mirror.id)[0];
    f.controls.close = () => { throw new Error('offline interruption'); };
    await exits(f.engine).runAdjustment(adjustment.id);
    const interrupted = f.repo.adjustments.get(adjustment.id)!;
    assert.equal(interrupted.beforeSize, '100');
    assert.equal(interrupted.availableSize, '50');
    f.getDb().prepare("UPDATE mirror_adjustments SET status = 'submitting' WHERE id = ?").run(adjustment.id);
    await exits(f.makeEngine(async () => ({ state: 'filled', sizeRaw: '25', notionalUsd: 25, orderId: 9001, txHash: null })))
      .reconcileAdjustment(adjustment.id);
    assert.equal(f.repo.mirrors.get(mirror.id)!.size, '50');
    assert.equal(f.repo.adjustments.get(adjustment.id)!.sizeDelta, '25');
    assert.equal(f.repo.adjustments.get(adjustment.id)!.status, 'done');
    assert.equal(f.closes.length, 1);
  });
}
