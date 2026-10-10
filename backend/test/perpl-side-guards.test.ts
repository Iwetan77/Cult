import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { TradingSession } from '../src/perpl/session.js';
import type { Position } from '../src/perpl/types.js';
import { installOfflineFetch, ownFixture, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

before(installOfflineFetch);
afterEach(async () => {
  stopFixtures();
  (await import('../src/accounts/lifecycle.js')).stopAllSessions();
});
after(verifyOffline);

for (const requested of ['long', 'short'] as const) {
  test(`the actual Perpl open adapter refuses ${requested} against the opposite session side before funding or sending`, async t => {
    const f = await ownFixture();
    const { TradingSession: Session } = await import('../src/perpl/session.js');
    const { perpl } = await import('../src/venues/perpl.js');
    const accountId = f.members.get(f.user)!.perplAccountId!;
    const opposite = requested === 'long' ? 2 : 1;
    const starts = t.mock.method(Session.prototype, 'start', async function (this: TradingSession) {
      this.positions.set(`${accountId}:16`, { acc: accountId, pid: 1, mkt: 16, sd: opposite, s: 100,
        ep: 1, lv: 200, c: '100000000' } as Position);
    });
    const orders = t.mock.method(Session.prototype, 'placeOrder', async () => { throw new Error('a side guard must never send'); });
    let refs = 0;
    await assert.rejects(perpl.open({ userId: f.user, market: '16', side: requested, notionalAusd: 100,
      leverage: 2, onRef: () => { refs++; } }), (error: { status?: number; message?: string }) =>
      error.status === 409 && !!error.message?.includes('opposite-side'));
    assert.equal(starts.mock.callCount(), 1, 'start is stubbed, not a real socket');
    assert.equal(orders.mock.callCount(), 0);
    assert.equal(refs, 0);
    assert.deepEqual(f.orders(), []);
  });

  test(`the actual Perpl close adapter rejects expected ${requested} when the session changed direction`, async t => {
    const f = await ownFixture();
    const { TradingSession: Session } = await import('../src/perpl/session.js');
    const { perpl } = await import('../src/venues/perpl.js');
    const accountId = f.members.get(f.user)!.perplAccountId!;
    const opposite = requested === 'long' ? 2 : 1;
    t.mock.method(Session.prototype, 'start', async function (this: TradingSession) {
      this.positions.set(`${accountId}:16`, { acc: accountId, pid: 2, mkt: 16, sd: opposite, s: 100,
        ep: 1, lv: 200, c: '100000000' } as Position);
    });
    const orders = t.mock.method(Session.prototype, 'placeOrder', async () => { throw new Error('a direction guard must never send'); });
    let refs = 0;
    await assert.rejects(perpl.close({ userId: f.user, market: '16', side: requested, sizeRaw: '50',
      onRef: () => { refs++; } }), (error: { status?: number; message?: string }) =>
      error.status === 409 && !!error.message?.includes('changed direction'));
    assert.equal(orders.mock.callCount(), 0);
    assert.equal(refs, 0);
    assert.deepEqual(f.orders(), []);
  });

  test(`the actual Perpl open adapter rechecks ${requested} after the margin check`, async t => {
    const f = await ownFixture();
    const { TradingSession: Session } = await import('../src/perpl/session.js');
    const { perpl } = await import('../src/venues/perpl.js');
    const accountId = f.members.get(f.user)!.perplAccountId!;
    const original = requested === 'long' ? 1 : 2;
    const opposite = requested === 'long' ? 2 : 1;
    t.mock.method(Session.prototype, 'start', async function (this: TradingSession) {
      this.positions.set(`${accountId}:16`, { acc: accountId, pid: 1, mkt: 16, sd: original, s: 100 } as Position);
      // Reading free margin stands in for a position update while funding.
      t.mock.method(this.accounts, 'get', () => {
        this.positions.set(`${accountId}:16`, { acc: accountId, pid: 1, mkt: 16, sd: opposite, s: 100 } as Position);
        return { id: accountId, b: '1000000000', lb: '0' };
      });
    });
    const orders = t.mock.method(Session.prototype, 'placeOrder', async () => { throw new Error('a changed direction must never send'); });
    await assert.rejects(perpl.open({ userId: f.user, market: '16', side: requested, notionalAusd: 100, leverage: 2 }),
      (error: { status?: number }) => error.status === 409);
    assert.equal(orders.mock.callCount(), 0);
  });
}
