import { before, after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET = '00'.repeat(32);
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH = '1';
process.env.LOG_REQUESTS = '0';
process.env.PERPL_API_URL = 'https://audience-test.invalid';

let createApp: typeof import('../src/api/server.js')['createApp'];
let members: typeof import('../src/store/members.js')['members'];
let clans: typeof import('../src/store/clans.js')['clans'];
let audience: typeof import('../src/mirror/audience.js');
let perpl: typeof import('../src/venues/perpl.js')['perpl'];
let nadfun: typeof import('../src/venues/nadfun.js')['nadfun'];
const meme = `0x${'a'.repeat(40)}`;
let next = 0;

before(async () => {
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://audience-test.invalid');
    assert.equal(url.pathname, '/v1/pub/context');
    return Response.json({ chain: { chain_id: 10143 }, instances: [], tokens: [], markets: [
      { id: 16, symbol: 'BTC', name: 'BTC', config: { is_open: true, price_decimals: 2, size_decimals: 3, initial_margin: 1000, maker_fee: 0, taker_fee: 0 } },
    ] });
  });
  ({ createApp } = await import('../src/api/server.js'));
  ({ members } = await import('../src/store/members.js'));
  ({ clans } = await import('../src/store/clans.js'));
  audience = await import('../src/mirror/audience.js');
  ({ perpl } = await import('../src/venues/perpl.js'));
  ({ nadfun } = await import('../src/venues/nadfun.js'));
});
after(() => mock.restoreAll());

function fixture(ready = true) {
  const userId = `audience-api-${++next}`;
  const wallet = `0x${next.toString(16).padStart(40, '0')}`;
  members.upsert(userId, wallet);
  if (ready) { members.setAccount(userId, next); members.setForwarding(userId, true); }
  const cult = clans.create('audience', userId);
  const engine = Object.assign(new EventEmitter(), { async watch() {} });
  const app = createApp(engine as unknown as import('../src/mirror/engine.js').MirrorEngine);
  const request = (body: unknown) => app.request('/v1/positions/open', {
    method: 'POST', headers: { authorization: `Dev ${userId} ${wallet}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { userId, cult, request };
}

test('unfinished setup never registers a private posting selection', async () => {
  const f = fixture(false);
  const response = await f.request({ marketId: '16', side: 'long', marginUsd: 10, cultIds: [] });
  assert.equal(response.status, 409);
  assert.equal(audience.takeAudience(f.userId, 'perpl', '16'), undefined);
});

test('invalid Perpl and meme sides never register a selection', async () => {
  const f = fixture();
  for (const [marketId, side, venue] of [['16', 'buy', 'perpl'], [meme, 'long', 'nadfun']]) {
    const response = await f.request({ marketId, side, marginUsd: 10, cultIds: [f.cult.id] });
    assert.equal(response.status, 400);
    assert.equal(audience.takeAudience(f.userId, venue, marketId), undefined);
  }
});

test('an invalid market cannot leave a private selection behind', async () => {
  const f = fixture();
  const response = await f.request({ marketId: '999999', side: 'long', marginUsd: 10, cultIds: [] });
  assert.notEqual(response.status, 200);
  assert.equal(audience.takeAudience(f.userId, 'perpl', '999999'), undefined);
});

test('successful orders preserve their selection until the venue event consumes it', async () => {
  const f = fixture();
  const open = mock.method(perpl, 'open', async input => ({ venue: 'perpl' as const, market: input.market, side: input.side, sizeRaw: '1', size: 1, priceAusd: 10, notionalAusd: 10 }));
  try {
    for (const cultIds of [[], [f.cult.id]]) {
      assert.equal((await f.request({ marketId: '16', side: 'long', marginUsd: 10, cultIds })).status, 200);
      assert.deepEqual(audience.takeAudience(f.userId, 'perpl', '16'), cultIds);
      assert.equal(audience.takeAudience(f.userId, 'perpl', '16'), undefined);
    }
  } finally { open.mock.restore(); }
});

test('asynchronous and synchronous venue failures clear the selection', async () => {
  const f = fixture();
  for (const [adapter, marketId, side, venue] of [[perpl, '16', 'long', 'perpl'], [nadfun, meme, 'buy', 'nadfun']] as const) {
    for (const sync of [false, true]) {
      const open = mock.method(adapter, 'open', sync ? (() => { throw new Error('offline rejection'); }) : (async () => { throw new Error('offline rejection'); }));
      try {
        assert.equal((await f.request({ marketId, side, marginUsd: 10, cultIds: [] })).status, 500);
        assert.equal(audience.takeAudience(f.userId, venue, marketId), undefined);
      } finally { open.mock.restore(); }
    }
  }
});
