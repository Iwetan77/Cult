import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

let chat: typeof import('../src/api/chat.js');
let clanId = '';
let otherClan = '';

before(async () => {
  chat = await import('../src/api/chat.js');
  const { clans } = await import('../src/store/clans.js');
  const { members } = await import('../src/store/members.js');
  for (const u of ['A', 'B']) members.upsert(u, `0x${u.repeat(40).toLowerCase()}`);
  const policy = { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 50 };
  clanId = clans.create('c', 'A', policy).id;
  otherClan = clans.create('d', 'B', policy).id;
});

test('messages page back from newest, oldest-first within a page', () => {
  const ids = [1, 2, 3].map((i) => chat.postMessage(clanId, 'A', { body: `m${i}` }).id);
  const p1 = chat.listMessages(clanId, { limit: 2 });
  assert.deepEqual(p1.messages.map((m) => m.body), ['m2', 'm3']);
  assert.equal(p1.hasMore, true);
  const p2 = chat.listMessages(clanId, { before: p1.messages[0]!.id, limit: 2 });
  assert.deepEqual(p2.messages.map((m) => m.id), [ids[0]]);
  assert.equal(p2.hasMore, false);
});

test('a reply must point at a message in the same clan', () => {
  const theirs = chat.postMessage(otherClan, 'B', { body: 'elsewhere' });
  assert.throws(() => chat.postMessage(clanId, 'B', { body: 'x', replyTo: theirs.id }), /not in this clan/);
});

test('empty and oversized messages are refused', () => {
  assert.throws(() => chat.postMessage(clanId, 'B', { body: '  \n ' }), /empty/);
  assert.throws(() => chat.postMessage(clanId, 'B', { body: 'x'.repeat(chat.MAX_MESSAGE_CHARS + 1) }), /over/);
});

test('a burst is slowed down', () => {
  const tries = Array.from({ length: 12 }, (_, i) => {
    try {
      chat.postMessage(otherClan, 'B', { body: `spam ${i}` });
      return 'ok';
    } catch (e) {
      return (e as { status?: number }).status;
    }
  });
  assert.ok(tries.includes(429));
  assert.ok(tries.filter((t) => t === 'ok').length <= 8);
});
