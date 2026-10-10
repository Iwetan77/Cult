// "Post to": a trade reaches only the cults it was posted to (copies, chart,
// notices); no pick means every cult the trader is in; an empty pick keeps it
// to themselves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

let engine: InstanceType<typeof import('../src/mirror/engine.js')['MirrorEngine']>;
let mirrors: typeof import('../src/mirror/repo.js')['mirrors'];
let audience: typeof import('../src/mirror/audience.js');
let tradeCults: typeof import('../src/mirror/repo.js')['tradeCults'];
let x = '';
let y = '';

const fake = {
  venue: 'perpl',
  async open() { throw new Error('not in this test'); },
  async close() { throw new Error('not in this test'); },
  async holdings() { return []; },
  async freeBalanceAusd() { return 1000; },
  async markPriceAusd() { return 1; },
  async maxLeverage() { return 10; },
};

before(async () => {
  const E = await import('../src/mirror/engine.js');
  const { clans } = await import('../src/store/clans.js');
  const { members } = await import('../src/store/members.js');
  ({ mirrors, tradeCults } = await import('../src/mirror/repo.js'));
  audience = await import('../src/mirror/audience.js');
  for (const u of ['L', 'F', 'G']) members.upsert(u, `0x${u.repeat(40).toLowerCase()}`);
  const on = { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 100 };
  x = clans.create('x', 'L', on).id;
  y = clans.create('y', 'L', on).id;
  clans.join(x, 'F', on);
  clans.join(y, 'G', on);
  engine = new E.MirrorEngine({ optOutSeconds: 60 }, { sessionFor: async () => { throw new Error('no sessions'); }, venue: () => fake as any, nadWatcher: null });
});

const open = (market: string) => engine.leaderOpened({ venue: 'perpl', userId: 'L', market, side: 'long', sizeRaw: '100', entryPriceAusd: 1, leverageHundredths: 200, marginFraction: 0.1 });

after(() => engine.stop());

test('no pick: every cult the trader is an admin of', async () => {
  const t = await open('16');
  assert.deepEqual([...t!.cultIds!].sort(), [x, y].sort()); // stored explicitly
  assert.deepEqual(mirrors.forTrade(t!.id).map((m) => m.userId).sort(), ['F', 'G']);
});

test('posted to one cult: only its followers copy, and it is stored on the trade', async () => {
  audience.setAudience('L', 'perpl', '32', [x]);
  const t = await open('32');
  assert.deepEqual(t!.cultIds, [x]);
  assert.deepEqual(mirrors.forTrade(t!.id).map((m) => m.userId), ['F']);
  assert.deepEqual(tradeCults(t!, [x, y]), [x], 'notices go to the picked cult only');
  assert.deepEqual(tradeCults(t!, [y]), [], "a cult they've since left gets nothing");
});

test('the pick is used once, then trades reach every cult again', async () => {
  const t = await open('32');
  assert.deepEqual([...t!.cultIds!].sort(), [x, y].sort());
});

test('posted to nobody: kept to themselves', async () => {
  audience.setAudience('L', 'perpl', '48', []);
  assert.equal(await open('48'), null);
});

// Only admins share trades with a cult. The creator always is one; others
// become admins when the owner makes them one.
test('a member who is not an admin: their trade stays theirs alone', async () => {
  const t = await engine.leaderOpened({ venue: 'perpl', userId: 'F', market: '64', side: 'long', sizeRaw: '100', entryPriceAusd: 1, leverageHundredths: 200, marginFraction: 0.1 });
  assert.equal(t, null);
});

test('made an admin: their trades are shared and copied', async () => {
  const { clans } = await import('../src/store/clans.js');
  assert.equal(clans.isAdmin(x, 'L'), true, 'the creator is an admin');
  assert.equal(clans.isAdmin(x, 'F'), false);
  clans.setRole(x, 'F', 'admin');
  assert.equal(clans.isAdmin(x, 'F'), true);
  const t = await engine.leaderOpened({ venue: 'perpl', userId: 'F', market: '80', side: 'long', sizeRaw: '100', entryPriceAusd: 1, leverageHundredths: 200, marginFraction: 0.1 });
  assert.deepEqual(t!.cultIds, [x]);
  assert.deepEqual(mirrors.forTrade(t!.id).map((m) => m.userId), ['L']);
  clans.setRole(x, 'F', 'member');
});
