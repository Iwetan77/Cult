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

test('room icons, and notices read as a sentence with the username', async () => {
  const rooms = chat.roomsFor('A');
  assert.deepEqual(rooms.map((r) => r.icon), ['G', '🇳🇬', 'C'], 'the Nigeria room gets its flag, not the C from "country:NG"');
  members.setUsername('A', 'iwetan');
  const n = chat.postSystem('global', 'A', 'joined Cult');
  assert.equal(n.memberName, 'iwetan');
  assert.equal(n.text, 'iwetan joined Cult');
  const t = chat.postMessage('global', 'A', { body: 'gm' });
  assert.equal(t.text, 'gm', 'a typed message shows its body');
});

// A 1x1 PNG, as the browser would send a resized photo.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('a photo can be sent alone or with a caption; fakes are refused', () => {
  members.upsert('D', `0x${'d'.repeat(40)}`); // a fresh sender: B used up its burst above
  const room = 'global';
  const alone = chat.postMessage(room, 'D', { body: '', image: PNG });
  assert.match(alone.imageUrl ?? '', /^\/v1\/chat-images\/[0-9a-f-]{36}$/);
  assert.equal(alone.body, '');
  const captioned = chat.postMessage(room, 'D', { body: 'look', image: PNG });
  assert.equal(captioned.body, 'look');
  assert.notEqual(captioned.imageUrl, alone.imageUrl, 'each photo gets its own id');
  assert.throws(() => chat.postMessage(room, 'D', { body: 'x', image: 'data:image/png;base64,AAAA' }), /isn't the image type/);
  assert.throws(() => chat.postMessage(room, 'D', { body: '', image: null }), /empty/);
  const listed = chat.listMessages(room).messages.find((m) => m.id === alone.id)!;
  assert.equal(listed.imageUrl, alone.imageUrl, 'the photo comes back with the message');
});

test('reactions toggle per member and show whose they are', async () => {
  const { clans } = await import('../src/store/clans.js');
  const room = chat.cultRoom(cultA);
  clans.join(cultA, 'C', { enabled: false, balancePercentCap: 10, maxUsdPerTrade: 50 });
  const msg = chat.postMessage(room, 'A', { body: 'react to me' });
  assert.deepEqual(chat.react(room, 'A', msg.id, '🔥'), [{ emoji: '🔥', count: 1, mine: true }]);
  assert.deepEqual(chat.react(room, 'C', msg.id, '🔥'), [{ emoji: '🔥', count: 2, mine: true }]);
  chat.react(room, 'C', msg.id, '🚀');
  const seenByA = chat.listMessages(room, { viewerId: 'A' }).messages.find((m) => m.id === msg.id)!;
  assert.deepEqual(seenByA.reactions, [{ emoji: '🔥', count: 2, mine: true }, { emoji: '🚀', count: 1, mine: false }]);
  assert.deepEqual(chat.react(room, 'A', msg.id, '🔥'), [{ emoji: '🔥', count: 1, mine: false }, { emoji: '🚀', count: 1, mine: false }], 'the same emoji again takes it back');
  assert.throws(() => chat.react(room, 'A', msg.id, '💩'), /react with one of/);
  assert.throws(() => chat.react('global', 'A', msg.id, '🔥'), /no such message in this room/);
});

test('a cult with a picture shows it as its room icon', async () => {
  const { cultImages, decodeImage } = await import('../src/store/media.js');
  cultImages.set(cultA, decodeImage(PNG, 1024));
  const icon = chat.roomsFor('A').find((r) => r.id === chat.cultRoom(cultA))!.icon;
  assert.ok(icon.startsWith(`/v1/cult-images/${cultA}?v=`), icon);
  cultImages.clear(cultA);
  assert.equal(chat.roomsFor('A').find((r) => r.id === chat.cultRoom(cultA))!.icon, 'C', 'back to the letter');
});
