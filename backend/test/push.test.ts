import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createECDH } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PushSubscription } from 'web-push';
import type { Position } from '../src/perpl/types.js';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);
process.env.DEV_AUTH = '1';
process.env.LOG_REQUESTS = '0';
let push: typeof import('../src/notifications/push.js');
let members: typeof import('../src/store/members.js')['members'];
let clans: typeof import('../src/store/clans.js')['clans'];
let db: ReturnType<typeof import('../src/store/db.js')['getDb']>;
let engineModule: typeof import('../src/mirror/engine.js');
let cultA: string, cultB: string;
const sub = (id: string): PushSubscription => {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};
const payload = { title: 'Cult trade', body: 'MON-PERP long', url: '/', tag: 'event' };

before(async () => {
  push = await import('../src/notifications/push.js');
  ({ members } = await import('../src/store/members.js'));
  ({ clans } = await import('../src/store/clans.js'));
  db = (await import('../src/store/db.js')).getDb();
  engineModule = await import('../src/mirror/engine.js');
  for (const id of ['A', 'B', 'C', 'D', 'private']) members.upsert(id, `0x${Buffer.from(id).toString('hex').padEnd(40, '0')}`);
  const policy = { enabled: false, balancePercentCap: 10, maxUsdPerTrade: 50 };
  cultA = clans.create('Alpha', 'A', policy).id;
  cultB = clans.create('Beta', 'A', policy).id;
  clans.join(cultA, 'B', policy);
  clans.join(cultB, 'C', policy);
});

test('only known HTTPS push services and valid keys are accepted', () => {
  const valid = sub('validation');
  push.validateSubscription(valid);
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://web.push.apple.com.attacker.example/x', 'https://fcm.googleapis.com:444/x', 'https://user:pass@fcm.googleapis.com/x']) {
    assert.throws(() => push.validateSubscription({ ...valid, endpoint }), /endpoint/);
  }
  assert.throws(() => push.validateSubscription({ ...valid, keys: { ...valid.keys, auth: 'bad' } }), /keys/);
});

test('VAPID keys persist encrypted and expose only the public key', () => {
  const key = push.pushPublicKey();
  assert.equal(push.pushPublicKey(), key);
  assert.equal(Buffer.from(key, 'base64url').length, 65);
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'push_vapid'").get() as { value: string };
  assert.ok(!stored.value.includes('privateKey'));
  assert.ok(!stored.value.includes(key));
});

test('subscription ownership cannot be overwritten or deleted by another member', async () => {
  const s = sub('ownership'); push.subscribePush('B', s);
  assert.throws(() => push.subscribePush('C', s), /previous notification/);
  push.unsubscribePush('C', s.endpoint);
  push.enqueuePush('ownership', [{ userId: 'B' }], payload);
  let count = 0;
  await push.flushPush(async subscription => { assert.equal(subscription.endpoint, s.endpoint); count++; });
  assert.equal(count, 1);
  push.unsubscribePush('B', s.endpoint);
});

test('private trades and non-admin trades have no cult push recipients', () => {
  const t = { userId: 'A', cultIds: [] } as any;
  assert.deepEqual(push.tradePushRecipients(t), []);
  assert.deepEqual(push.tradePushRecipients({ userId: 'B', cultIds: null } as any), []);
  assert.deepEqual(push.tradePushRecipients({ userId: 'A', cultIds: [cultB] } as any), [{ userId: 'C', clanId: cultB }]);
});

test('events are deduplicated and links target the recipient\'s own cult', async () => {
  const s = sub('dedupe'); push.subscribePush('B', s);
  push.enqueuePush('dedupe', [{ userId: 'B', clanId: cultA }, { userId: 'B', clanId: cultB }], payload);
  push.enqueuePush('dedupe', [{ userId: 'B' }], payload);
  let count = 0;
  await push.flushPush(async (_subscription, body) => { count++; assert.equal(JSON.parse(body).url, `/cults/${cultA}`); });
  await push.flushPush(async () => { count++; });
  assert.equal(count, 1);
  push.unsubscribePush('B', s.endpoint);
});

test('leaving a private cult cancels already queued alerts', async () => {
  const s = sub('left'); push.subscribePush('B', s);
  push.enqueuePush('left', [{ userId: 'B', clanId: cultA }], payload);
  clans.leave(cultA, 'B');
  await push.flushPush(async () => { assert.fail('must not disclose a former cult\'s trade'); });
  clans.join(cultA, 'B', { enabled: false, balancePercentCap: 10, maxUsdPerTrade: 50 });
  push.unsubscribePush('B', s.endpoint);
});

test('expired endpoints are removed and transient delivery failures back off', async () => {
  const gone = sub('gone'); push.subscribePush('D', gone);
  push.enqueuePush('gone', [{ userId: 'D' }], payload);
  await push.flushPush(async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); });
  assert.equal((db.prepare("SELECT count(*) AS n FROM push_subscriptions WHERE user_id = 'D'").get() as { n: number }).n, 0);
  const retry = sub('retry'); push.subscribePush('D', retry);
  const now = Date.now();
  push.enqueuePush('retry', [{ userId: 'D' }], payload, now);
  let tries = 0;
  const send = async () => { tries++; if (tries === 1) throw new Error('temporary'); };
  await push.flushPush(send, now);
  await push.flushPush(send, now + 10_000);
  assert.equal(tries, 1);
  await push.flushPush(send, now + 31_000);
  assert.equal(tries, 2);
  push.unsubscribePush('D', retry.endpoint);
});

test('push subscription endpoints require authentication', async () => {
  const { createApp } = await import('../src/api/server.js');
  const engine = new engineModule.MirrorEngine({ optOutSeconds: 20 }, { sessionFor: async () => { throw new Error('offline test'); }, nadWatcher: null });
  const app = createApp(engine);
  assert.equal((await app.request('/v1/notifications/push')).status, 401);
  const authorization = `Dev D ${members.get('D')!.wallet}`;
  const key = await app.request('/v1/notifications/push', { headers: { authorization } });
  assert.equal(key.status, 200);
  assert.deepEqual(Object.keys(await key.json()), ['publicKey']);
  const s = sub('api');
  const post = await app.request('/v1/notifications/push', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(s) });
  assert.equal(post.status, 204);
  const testAlert = () => app.request('/v1/notifications/push/test', { method: 'POST', headers: { authorization } });
  assert.equal((await testAlert()).status, 204);
  const limited = await testAlert();
  assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
  assert.equal((await app.request('/v1/notifications/push', { method: 'DELETE', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: s.endpoint }) })).status, 204);
});

test('confirmed liquidations emit for private and copied positions, ordinary closes do not', async () => {
  const session = new EventEmitter();
  members.setApiKey('private', 'test', new Uint8Array(32), 'public');
  const engine = new engineModule.MirrorEngine({ optOutSeconds: 20 }, { sessionFor: async () => session as any, nadWatcher: null });
  await engine.watch('private');
  const events: string[] = [];
  engine.on('liquidation', userId => events.push(userId));
  const p = { acc: 999, pid: 123, mkt: 16, st: 2 } as Position;
  session.emit('positionClosed', p);
  assert.deepEqual(events, []);
  session.emit('positionClosed', { ...p, st: 3 });
  assert.deepEqual(events, ['private']);
});
