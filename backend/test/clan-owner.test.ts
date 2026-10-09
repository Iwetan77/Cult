import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET = '00'.repeat(32);
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH = '1';
process.env.LOG_REQUESTS = '0';
process.env.INDEXER_GRAPHQL_URL = '';
process.env.INDEXER_PG_URL = '';
process.env.PERPL_API_URL = 'https://owner-test.invalid';

let clans: typeof import('../src/store/clans.js')['clans'];
let members: typeof import('../src/store/members.js')['members'];
let getDb: typeof import('../src/store/db.js')['getDb'];
let createApp: typeof import('../src/api/server.js')['createApp'];

const users = ['owner', 'admin', 'member', 'outsider'];
const wallet = (user: string) => `0x${String(users.indexOf(user) + 1).padStart(40, '0')}`;

before(async () => {
  // All chart reads are fixtures; unexpected network calls fail locally.
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://owner-test.invalid');
    if (url.pathname === '/v1/pub/context') return Response.json({
      chain: { chain_id: 10143 }, instances: [], tokens: [],
      markets: [{ id: 16, symbol: 'BTC', name: 'BTC', config: {
        is_open: true, price_decimals: 2, size_decimals: 3,
        initial_margin: 1000, maker_fee: 0, taker_fee: 0,
      } }],
    });
    if (url.pathname === '/v1/market-data/ticker') return Response.json({ sn: 1, d: { '16': { mrk: 10000 } } });
    if (url.pathname.startsWith('/v1/market-data/16/candles/')) return Response.json({ d: [] });
    assert.fail(`unexpected network request: ${url.pathname}`);
  });
  ({ clans } = await import('../src/store/clans.js'));
  ({ members } = await import('../src/store/members.js'));
  ({ getDb } = await import('../src/store/db.js'));
  ({ createApp } = await import('../src/api/server.js'));
  for (const user of users) members.upsert(user, wallet(user));
});

after(() => mock.restoreAll());

function fixture() {
  const clan = clans.create('owner permissions', 'owner');
  clans.join(clan.id, 'admin');
  clans.join(clan.id, 'member');
  clans.setRole(clan.id, 'admin', 'admin');
  const left: string[][] = [];
  const engine = Object.assign(new EventEmitter(), {
    async watch() {},
    memberLeft(clanId: string, userId: string) { left.push([clanId, userId]); },
  });
  const app = createApp(engine as unknown as import('../src/mirror/engine.js').MirrorEngine);
  const request = (path: string, user: string, body: unknown = {}, method = 'POST') => app.request(path, {
    method,
    headers: { authorization: `Dev ${user} ${wallet(user)}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  const notices = () => (getDb().prepare('SELECT count(*) AS n FROM chat_messages WHERE room = ?').get(`cult:${clan.id}`) as { n: number }).n;
  return { clan, app, left, request, notices };
}

test('store refuses owner demotion without changing membership or ownership', () => {
  const { clan } = fixture();
  const before = clans.membership(clan.id, 'owner');
  assert.equal(before?.role, 'admin');
  assert.throws(() => clans.setRole(clan.id, 'owner', 'member'), { message: 'The cult owner cannot be demoted.' });
  clans.setRole(clan.id, 'owner', 'admin');
  assert.deepEqual(clans.membership(clan.id, 'owner'), before);
  assert.equal(clans.get(clan.id)?.createdBy, 'owner');
});

test('legacy creator role rows still expose admin membership and preserve protection', () => {
  const { clan } = fixture();
  getDb().prepare("UPDATE clan_members SET role = 'member' WHERE clan_id = ? AND user_id = ?").run(clan.id, 'owner');
  assert.equal(clans.membership(clan.id, 'owner')?.role, 'admin');
  assert.equal(clans.members(clan.id).find(m => m.userId === 'owner')?.role, 'admin');
  assert.equal(clans.isAdmin(clan.id, 'owner'), true);
  assert.ok(clans.adminCultIds('owner').includes(clan.id));
  assert.throws(() => clans.setRole(clan.id, 'owner', 'member'), { message: 'The cult owner cannot be demoted.' });
  assert.equal(clans.membership(clan.id, 'member')?.role, 'member');
});

test('owner can leave voluntarily and rejoin as admin; repeated joins preserve other roles and policy', () => {
  const { clan } = fixture();
  clans.leave(clan.id, 'owner');
  assert.equal(clans.membership(clan.id, 'owner'), null);
  assert.equal(clans.get(clan.id)?.createdBy, 'owner');
  clans.join(clan.id, 'owner');
  const row = getDb().prepare('SELECT role FROM clan_members WHERE clan_id = ? AND user_id = ?').get(clan.id, 'owner') as { role: string };
  assert.equal(row.role, 'admin');
  const before = clans.membership(clan.id, 'admin');
  clans.join(clan.id, 'admin', { enabled: true, balancePercentCap: 20, maxUsdPerTrade: 50 });
  assert.deepEqual(clans.membership(clan.id, 'admin'), before);
});

test('store preserves promotion, demotion and leaving for ordinary members', () => {
  const { clan } = fixture();
  clans.setRole(clan.id, 'member', 'admin');
  assert.equal(clans.isAdmin(clan.id, 'member'), true);
  clans.setRole(clan.id, 'member', 'member');
  assert.equal(clans.isAdmin(clan.id, 'member'), false);
  clans.leave(clan.id, 'admin');
  assert.equal(clans.membership(clan.id, 'admin'), null);
  assert.equal(clans.isAdmin(clan.id, 'admin'), false);
  assert.equal(clans.get(clan.id)?.createdBy, 'owner');
});

for (const base of ['/v1/cults', '/v1/clans']) {
  test(`${base}: the creator cannot strip owner admin, including a legacy bad row`, async () => {
    const { clan, request, notices } = fixture();
    for (const role of ['admin', 'member']) {
      getDb().prepare('UPDATE clan_members SET role = ? WHERE clan_id = ? AND user_id = ?').run(role, clan.id, 'owner');
      const denied = await request(`${base}/${clan.id}/admins`, 'owner', { memberId: 'owner', admin: false });
      assert.equal(denied.status, 400);
      assert.deepEqual(await denied.json(), { message: 'The cult owner cannot be demoted.' });
      const response = await request(`${base}/${clan.id}/admins`, 'owner', { memberId: 'owner', admin: true });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { memberId: 'owner', admin: true, owner: true });
      assert.equal(clans.membership(clan.id, 'owner')?.role, 'admin');
    }
    assert.equal(notices(), 0);
    assert.equal(clans.get(clan.id)?.createdBy, 'owner');
  });

  test(`${base}: only the owner changes admin roles, with notices only on changes`, async () => {
    const { clan, request, notices } = fixture();
    const path = `${base}/${clan.id}/admins`;
    for (const admin of [true, true, false, false]) {
      const response = await request(path, 'owner', { memberId: 'member', admin });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { memberId: 'member', admin, owner: false });
      assert.equal(clans.isAdmin(clan.id, 'member'), admin);
    }
    assert.equal(notices(), 2);
    assert.equal((await request(path, 'owner', { memberId: 'admin', admin: false })).status, 200);
    assert.equal(clans.isAdmin(clan.id, 'admin'), false);
    assert.equal((await request(path, 'admin', { memberId: 'member', admin: true })).status, 403);
    assert.equal(notices(), 3);
  });

  test(`${base}: admins cannot promote, demote, self-demote or spoof ownership`, async () => {
    const { clan, request, notices } = fixture();
    const path = `${base}/${clan.id}/admins`;
    for (const memberId of ['member', 'admin', 'owner']) {
      for (const admin of [true, false]) {
        const response = await request(path, 'admin', { memberId, admin, owner: true, createdBy: 'admin' });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { message: 'only the cult owner can change admins' });
      }
    }
    assert.equal(clans.membership(clan.id, 'member')?.role, 'member');
    assert.equal(clans.membership(clan.id, 'admin')?.role, 'admin');
    assert.equal(clans.membership(clan.id, 'owner')?.role, 'admin');
    assert.equal(clans.get(clan.id)?.createdBy, 'owner');
    assert.equal(notices(), 0);
  });

  test(`${base}: members and outsiders cannot manage roles; owner requests are validated`, async () => {
    const { clan, app, request, notices } = fixture();
    const path = `${base}/${clan.id}/admins`;
    assert.equal((await app.request(path, { method: 'POST', body: '{}' })).status, 401);
    for (const memberId of ['member', 'owner']) {
      assert.equal((await request(path, 'member', { memberId, admin: true, owner: true, createdBy: 'member' })).status, 403);
      assert.equal((await request(path, 'outsider', { memberId, admin: true })).status, 404);
    }
    assert.equal((await request(path, 'owner', { memberId: 'outsider', admin: true })).status, 404);
    assert.equal((await request(path, 'owner', { memberId: 'member', admin: 'false' })).status, 400);
    assert.equal((await request(path, 'admin', { memberId: 'member', admin: 'false' })).status, 403);
    assert.equal(clans.isAdmin(clan.id, 'member'), false);
    assert.equal(clans.get(clan.id)?.createdBy, 'owner');
    assert.equal(notices(), 0);
  });

  test(`${base}: only the immutable owner can change visibility or pin`, async () => {
    const { clan, request } = fixture();
    getDb().prepare("UPDATE clan_members SET role = 'member' WHERE clan_id = ? AND user_id = ?").run(clan.id, 'owner');
    const path = `${base}/${clan.id}/visibility`;
    for (const actor of ['admin', 'member']) {
      assert.equal((await request(path, actor, { visibility: 'public', createdBy: actor, owner: true })).status, 403);
      assert.equal((await request(`/v1/chat/cult:${clan.id}/pin`, actor, { messageId: null })).status, 403);
    }
    const response = await request(path, 'owner', { visibility: 'public', createdBy: 'admin' });
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.equal(view.isOwner, true);
    assert.equal(view.isAdmin, true);
    assert.equal(view.visibility, 'public');
    assert.equal((await request(`/v1/chat/cult:${clan.id}/pin`, 'owner', { messageId: null })).status, 200);
    assert.equal(clans.get(clan.id)?.createdBy, 'owner');
  });

  test(`${base}: owner can leave voluntarily; an admin cannot target the owner through leave`, async () => {
    const { clan, request, left, notices } = fixture();
    assert.equal((await request(`${base}/${clan.id}/leave`, 'admin', { memberId: 'owner', userId: 'owner' })).status, 204);
    assert.deepEqual(left, [[clan.id, 'admin']]);
    assert.equal(clans.membership(clan.id, 'admin'), null);
    assert.ok(clans.membership(clan.id, 'owner'));
    assert.equal(notices(), 1);
    const response = await request(`${base}/${clan.id}/leave`, 'owner', { memberId: 'member', userId: 'member' });
    assert.equal(response.status, 204);
    assert.deepEqual(left, [[clan.id, 'admin'], [clan.id, 'owner']]);
    assert.equal(clans.membership(clan.id, 'owner'), null);
    assert.ok(clans.membership(clan.id, 'member'));
    assert.equal(clans.get(clan.id)?.createdBy, 'owner');
    assert.equal(notices(), 2);
  });

  test(`${base}: chart exposes exactly one owner and keeps creator admin with a legacy bad row`, async () => {
    const { clan, request } = fixture();
    for (const role of ['admin', 'member']) {
      getDb().prepare('UPDATE clan_members SET role = ? WHERE clan_id = ? AND user_id = ?').run(role, clan.id, 'owner');
      const response = await request(`${base}/${clan.id}/chart?marketId=16&resolution=86400`, 'member', {}, 'GET');
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.deepEqual(snapshot.members.map((m: { id: string; admin: boolean; owner: boolean }) => ({ id: m.id, admin: m.admin, owner: m.owner })).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)), [
        { id: 'admin', admin: true, owner: false },
        { id: 'member', admin: false, owner: false },
        { id: 'owner', admin: true, owner: true },
      ]);
    }
  });
}
