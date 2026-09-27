import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

let chat: typeof import('../src/api/chat.js');
let members: typeof import('../src/store/members.js')['members'];
let cultA = '';
let cultB = '';

before(async () => {
  chat = await import('../src/api/chat.js');
  const { clans } = await import('../src/store/clans.js');
  ({ members } = await import('../src/store/members.js'));
  for (const u of ['A', 'B', 'C']) members.upsert(u, `0x${u.repeat(40).toLowerCase()}`);
  const policy = { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 50 };
  cultA = clans.create('c', 'A', policy).id;
  cultB = clans.create('d', 'B', policy).id;
  members.setCountry('A', 'NG');
  members.setCountry('B', 'GB');
});

test('messages page back from newest, oldest-first within a page', () => {
  const room = chat.cultRoom(cultA);
  const ids = [1, 2, 3].map((i) => chat.postMessage(room, 'A', { body: `m${i}` }).id);
  const p1 = chat.listMessages(room, { limit: 2 });
  assert.deepEqual(p1.messages.map((m) => m.body), ['m2', 'm3']);
  assert.equal(p1.messages[0]!.clanId, cultA, 'cult rooms keep clanId for older clients');
  assert.equal(p1.hasMore, true);
  const p2 = chat.listMessages(room, { before: p1.messages[0]!.id, limit: 2 });
  assert.deepEqual(p2.messages.map((m) => m.id), [ids[0]]);
  assert.equal(p2.hasMore, false);
});

test('who gets into which room: global for all, country by pick, cult by membership', () => {
  assert.equal(chat.openRoom('global', 'C').name, 'Global');
  assert.equal(chat.openRoom('country:ng', 'A').room, 'country:NG', 'codes are case-forgiving');
  assert.equal(chat.openRoom('country:NG', 'A').name, 'Nigeria');
  assert.throws(() => chat.openRoom('country:NG', 'B'), /pick Nigeria/);
  assert.throws(() => chat.openRoom('country:QQ', 'A'), /no such room/);
  assert.throws(() => chat.openRoom(chat.cultRoom(cultB), 'A'), /no such room/, 'private cult rooms stay private');
  assert.throws(() => chat.openRoom('lobby', 'A'), /no such room/);
  assert.deepEqual(chat.roomsFor('A').map((r) => r.id), ['global', 'country:NG', chat.cultRoom(cultA)]);
  assert.deepEqual(chat.roomsFor('C').map((r) => r.id), ['global'], 'no country picked yet: just global');
});

test('a reply must point at a message in the same room', () => {
  const theirs = chat.postMessage(chat.cultRoom(cultB), 'B', { body: 'elsewhere' });
  assert.throws(() => chat.postMessage(chat.cultRoom(cultA), 'B', { body: 'x', replyTo: theirs.id }), /not in this room/);
});

test('empty and oversized messages are refused', () => {
  assert.throws(() => chat.postMessage('global', 'B', { body: '  \n ' }), /empty/);
  assert.throws(() => chat.postMessage('global', 'B', { body: 'x'.repeat(chat.MAX_MESSAGE_CHARS + 1) }), /over/);
});

test('a burst is slowed down, across rooms', () => {
  const tries = Array.from({ length: 12 }, (_, i) => {
    try {
      chat.postMessage(i % 2 ? 'global' : 'country:GB', 'B', { body: `spam ${i}` });
      return 'ok';
    } catch (e) {
      return (e as { status?: number }).status;
    }
  });
  assert.ok(tries.includes(429));
  assert.ok(tries.filter((t) => t === 'ok').length <= 8);
});

test('system notices, room activity and pins', () => {
  const room = chat.cultRoom(cultA);
  const sys = chat.postSystem(room, 'A', 'joined the cult');
  assert.equal(sys.kind, 'system');
  const r = chat.roomsFor('A').find((x) => x.id === room)!;
  assert.equal(r.lastMessage?.id, sys.id, 'the room list shows the latest line');
  assert.equal(r.memberCount, 1);
  assert.equal(chat.roomsFor('A')[0]!.memberCount, 3, 'global counts everyone');
  assert.match(chat.listMessages('global').pinned!.body, /Every trader on Cult starts here/);
  assert.equal(chat.listMessages(room).pinned, null);
  const msg = chat.postMessage(room, 'A', { body: 'rules: announce before you trade' });
  assert.throws(() => chat.setPin(room, 'B', msg.id), /only the cult owner/);
  assert.throws(() => chat.setPin('global', 'A', msg.id), /only cult rooms/);
  assert.equal(chat.setPin(room, 'A', msg.id)!.body, 'rules: announce before you trade');
  assert.equal(chat.listMessages(room).pinned!.id, msg.id);
  assert.equal(chat.setPin(room, 'A', null), null);
});
