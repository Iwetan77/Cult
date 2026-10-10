import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { holding, installOfflineFetch, marketFor, ownFixture, stopFixtures, verifyOffline } from './helpers/own-order-fixture.js';

process.env.NODE_ENV = 'test';
process.env.DEV_AUTH = '1';
process.env.LOG_REQUESTS = '0';
let createApp: typeof import('../src/api/server.js')['createApp'];
let chartTrades: typeof import('../src/api/chart.js')['chartTrades'];
before(async () => {
  installOfflineFetch();
  ({ createApp } = await import('../src/api/server.js'));
  ({ chartTrades } = await import('../src/api/chart.js'));
});
afterEach(stopFixtures);
after(verifyOffline);

const waitFor = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(done(), 'copy adjustment should settle');
};

test('old memberships and copies default to following exits; omitted policy field preserves the choice', async () => {
  const f = await ownFixture();
  const t = f.seedTrade('100');
  const m = f.seedMirror(t, '40', f.followerA);
  assert.equal(f.clans.membership(f.cultA, f.followerA)!.policy.followExits, true);
  assert.equal(m.followExits, true);
  f.engine.setFollowExits(f.cultA, f.followerA, false);
  f.clans.setPolicy(f.cultA, f.followerA, { enabled: false, balancePercentCap: 5, maxUsdPerTrade: 25 });
  assert.equal(f.clans.membership(f.cultA, f.followerA)!.policy.followExits, false);
  assert.equal(f.repo.mirrors.get(m.id)!.followExits, false);
  assert.equal(f.clans.membership(f.cultB, f.followerB)!.policy.followExits, true);
});

for (const v of ['perpl', 'nadfun'] as const) test(`${v}: one member keeps their copy while another follows partial and full exits`, async () => {
  const f = await ownFixture();
  const t = f.seedTrade('100', { venue: v, market: marketFor(v), side: v === 'perpl' ? 'long' : 'buy' });
  const kept = f.seedMirror(t, '40', f.followerA);
  const following = f.seedMirror(t, '60', f.shared);
  f.put(f.followerA, holding(v, '40'));
  f.put(f.shared, holding(v, '60'));
  f.engine.setFollowExits(f.cultA, f.followerA, false);
  await f.engine.leaderResized(t, 50n, 1, undefined, true);
  await waitFor(() => f.repo.mirrors.get(following.id)!.size === '30');
  assert.equal(f.repo.mirrors.get(kept.id)!.size, '40');
  assert.deepEqual(f.repo.adjustments.forMirror(kept.id), []);
  await f.engine.closeTrade(f.repo.trades.get(t.id)!);
  assert.equal(f.repo.mirrors.get(following.id)!.status, 'closed');
  assert.equal(f.repo.mirrors.get(kept.id)!.status, 'open');
  assert.ok(f.closes.every(c => c.userId === f.shared));
  assert.ok(chartTrades(f.cultA, [f.user, f.followerA]).some(x => x.id === t.id), 'kept copy stays chart-visible');
  f.engine.setFollowExits(f.cultA, f.followerA, true);
  assert.equal(f.repo.mirrors.get(kept.id)!.followExits, false, 'no retroactive exit after re-enabling');
  const closed = await f.engine.executeOwnClose({ userId: f.followerA, market: marketFor(v), side: t.side }, `mirror:${kept.id}`);
  assert.equal(closed.sizeRaw, '40');
  assert.equal(f.repo.mirrors.get(kept.id)!.status, 'closed', 'manual closing is still available');
  assert.ok(!chartTrades(f.cultA, [f.user, f.followerA]).some(x => x.id === t.id));
});

test('new pending copies inherit the member choice in the selected cult', async () => {
  const f = await ownFixture();
  f.engine.setFollowExits(f.cultA, f.followerA, false);
  const result = await f.ownOpen('perpl', [f.cultA]);
  const copies = f.repo.mirrors.forTrade(result.tradeId!);
  assert.equal(copies.find(m => m.userId === f.followerA)!.followExits, false);
  assert.equal(copies.find(m => m.userId === f.shared)!.followExits, true);
});

test('turning exits off cancels unsent reductions but leaves pending adds intact', async () => {
  const f = await ownFixture();
  const t = f.seedTrade('100');
  const m = f.seedMirror(t, '40', f.followerA);
  const add = f.repo.adjustments.insert({ mirrorId: m.id, tradeId: t.id, clanId: f.cultA, userId: f.followerA, kind: 'add', ratio: 1.5, skipUntil: Date.now() + 60000 });
  await f.engine.leaderResized(t, 50n, 1, undefined, true);
  const reduce = f.repo.adjustments.forMirror(m.id).find(a => a.kind === 'reduce')!;
  f.engine.setFollowExits(f.cultA, f.followerA, false);
  assert.equal(f.repo.adjustments.get(reduce.id)!.status, 'cancelled');
  assert.equal(f.repo.adjustments.get(add.id)!.status, 'pending');
  assert.equal(f.closes.length, 0);
});

test('turning exits off during a holdings lookup prevents the unsent close', async t => {
  const f = await ownFixture();
  const trade = f.seedTrade('100');
  const m = f.seedMirror(trade, '40', f.followerA);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(r => { started = r; });
  const held = new Promise<void>(r => { release = r; });
  t.mock.method(f.adapters.perpl, 'holdings', async () => { started(); await held; return [holding('perpl', '40')]; });
  const exit = f.engine.closeTrade(trade);
  await waiting;
  f.engine.setFollowExits(f.cultA, f.followerA, false);
  release();
  await exit;
  assert.equal(f.closes.length, 0);
  assert.equal(f.repo.mirrors.get(m.id)!.status, 'open');
});

test('exit preferences persist on open copies after leaving the cult', async () => {
  const f = await ownFixture();
  const t = f.seedTrade('100');
  const m = f.seedMirror(t, '40', f.followerA);
  f.engine.setFollowExits(f.cultA, f.followerA, false);
  f.engine.memberLeft(f.cultA, f.followerA);
  f.clans.leave(f.cultA, f.followerA);
  await f.engine.closeTrade(t);
  assert.equal(f.repo.mirrors.get(m.id)!.status, 'open');
  assert.equal(f.closes.length, 0);
});

test('recovery books a broadcast exit even with following disabled, without sending another', async t => {
  const f = await ownFixture();
  const trade = f.seedTrade('100');
  const m = f.seedMirror(trade, '40', f.followerA);
  f.engine.setFollowExits(f.cultA, f.followerA, false);
  f.repo.trades.markClosed(trade.id);
  f.repo.mirrors.patch(m.id, { closeRef: 'broadcast-exit', closeBeforeSize: '40', closeRequestedSize: '40', closeBookedSize: '0' });
  const recovered = f.makeEngine(async (_v, kind, id) => kind === 'mirror_close' && id === 'broadcast-exit'
    ? { state: 'filled', sizeRaw: '20', notionalUsd: 20, orderId: 100, txHash: '0xfilled' } : { state: 'none' });
  t.mock.method(recovered, 'watch', async () => {});
  await recovered.start(); await recovered.recovered();
  assert.equal(f.repo.mirrors.get(m.id)!.size, '20');
  assert.equal(f.repo.mirrors.get(m.id)!.status, 'open');
  assert.equal(f.closes.length, 0);
});

test('exit endpoint is member-only, personal, validated, and works through both route aliases', async () => {
  const f = await ownFixture();
  const app = createApp(f.engine);
  const request = (userId: string, cultId: string, enabled: unknown, prefix = 'cults') => app.request(`/v1/${prefix}/${cultId}/follow-exits`, {
    method: 'POST', headers: { authorization: `Dev ${userId} ${f.members.get(userId)!.wallet}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  assert.equal((await request(f.stranger, f.cultA, false)).status, 404);
  assert.equal((await request(f.followerA, f.cultB, false)).status, 404);
  assert.equal((await request(f.followerA, f.cultA, 'false')).status, 400);
  const off = await request(f.followerA, f.cultA, false);
  assert.equal(off.status, 200);
  assert.equal((await off.json() as { myPolicy: { followExits: boolean } }).myPolicy.followExits, false);
  assert.equal(f.clans.membership(f.cultA, f.shared)!.policy.followExits, true);
  assert.equal((await request(f.followerA, f.cultA, true, 'clans')).status, 200);
});

for (const filled of [true, false]) test(`recovery of a partial exit after opt-out ${filled ? 'books the confirmed sale' : 'does not retry an unsent sale'}`, async t => {
  const f = await ownFixture();
  const trade = f.seedTrade('100');
  const m = f.seedMirror(trade, '40', f.followerA);
  f.engine.setFollowExits(f.cultA, f.followerA, false);
  const a = f.repo.adjustments.insert({ mirrorId: m.id, tradeId: trade.id, clanId: f.cultA, userId: f.followerA, kind: 'reduce', ratio: 0.5, skipUntil: Date.now() });
  f.repo.adjustments.transition(a.id, 'pending', 'submitting', { beforeSize: '40', availableSize: '40' });
  const recovered = f.makeEngine(async (_v, kind, id) => filled && kind === 'mirror_reduce' && id === a.id
    ? { state: 'filled', sizeRaw: '20', notionalUsd: 20, orderId: 101, txHash: '0xpartial' } : { state: 'none' });
  t.mock.method(recovered, 'watch', async () => {});
  await recovered.start(); await recovered.recovered();
  assert.equal(f.repo.mirrors.get(m.id)!.size, filled ? '20' : '40');
  assert.equal(f.repo.adjustments.get(a.id)!.status, filled ? 'done' : 'cancelled');
  assert.equal(f.closes.length, 0);
});
