import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { MirrorEngine } from '../src/mirror/engine.js';
import type { LeaderTrade, Mirror, MirrorStatus } from '../src/mirror/repo.js';
import type { marketSymbol } from '../src/api/symbols.js';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);
const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('activity tests must not access the network');
});

let startActivityFeed: typeof import('../src/api/activity.js')['startActivityFeed'];
let chat: typeof import('../src/api/chat.js');
let repo: typeof import('../src/mirror/repo.js');
let members: typeof import('../src/store/members.js')['members'];
let getDb: typeof import('../src/store/db.js')['getDb'];
let cultA: string, cultB: string, cultOther: string;

before(async () => {
  ({ startActivityFeed } = await import('../src/api/activity.js'));
  chat = await import('../src/api/chat.js');
  repo = await import('../src/mirror/repo.js');
  ({ members } = await import('../src/store/members.js'));
  ({ getDb } = await import('../src/store/db.js'));
  const { clans } = await import('../src/store/clans.js');
  for (const [id, digit] of [['leader', '1'], ['follower', '2'], ['outsider', '3'], ['unnamed', '4']]) {
    members.upsert(id, `0x${digit.repeat(40)}`);
  }
  members.setUsername('leader', 'leaderName');
  members.setCountry('follower', 'NG');
  cultA = clans.create('First', 'leader').id;
  cultB = clans.create('Second', 'follower').id;
  cultOther = clans.create('Other', 'outsider').id;
  clans.join(cultA, 'follower');
  clans.join(cultA, 'unnamed');
  clans.join(cultB, 'leader');
  clans.setRole(cultB, 'leader', 'admin');
});

beforeEach(() => {
  getDb().exec('DELETE FROM chat_messages');
  members.setUsername('follower', 'copyMember');
});

after(() => {
  assert.equal(network.mock.callCount(), 0, 'every market lookup was mocked');
  mock.restoreAll();
});

function trade(venue: LeaderTrade['venue'] = 'perpl', patch: Partial<LeaderTrade> = {}): LeaderTrade {
  return repo.trades.insert({
    id: randomUUID(), venue, userId: 'leader', accountId: null,
    market: venue === 'perpl' ? '16' : `0x${'a'.repeat(40)}`,
    side: venue === 'perpl' ? 'long' : 'buy', positionId: null,
    size: '1000', entryPrice: 10, leverage: 500, marginFraction: 0.1,
    openTx: '0xleader', openedAt: Date.now(), cultIds: [cultA, cultB], ...patch,
  });
}

function copy(t = trade(), patch: Partial<Mirror> = {}): Mirror {
  const m = repo.mirrors.insertPending({ tradeId: t.id, clanId: cultA, userId: patch.userId ?? 'follower', skipUntil: Date.now() });
  repo.mirrors.transition(m.id, 'pending', 'submitting');
  return { ...repo.mirrors.transition(m.id, 'submitting', 'open', {
    size: '200', marginUsd: 10, notionalUsd: 20, openRq: 101, openOid: 201, openTx: '0xcopy',
  })!, ...patch };
}

function feed(symbol: typeof marketSymbol = mock.fn(async (venue) => venue === 'perpl' ? 'BTC-PERP' : '$MOE')) {
  const engine = new EventEmitter() as unknown as MirrorEngine;
  startActivityFeed(engine, symbol);
  return engine;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const messages = () => chat.listMessages(chat.cultRoom(cultA), { limit: 100 }).messages;
const closed = (m: Mirror, patch: Partial<Mirror> = {}): Mirror => ({ ...m, status: 'closed', closeOid: 301, closeTx: '0xclose', ...patch });

test('confirmed copy open is attributed to the follower and links its mirror marker', async () => {
  const m = copy();
  feed().emit('mirror', m);
  await flush();
  const [notice] = messages();
  assert.equal(messages().length, 1);
  assert.equal(notice.kind, 'system');
  assert.equal(notice.room, chat.cultRoom(cultA));
  assert.equal(notice.clanId, cultA);
  assert.equal(notice.memberId, 'follower');
  assert.equal(notice.memberName, 'copyMember');
  assert.equal(notice.body, 'opened an automatic copy of BTC-PERP long');
  assert.equal(notice.text, 'copyMember opened an automatic copy of BTC-PERP long');
  assert.equal(notice.markerId, `mirror:${m.id}`);
  assert.equal(repo.mirrors.get(m.id)!.status, 'open', 'the feed does not change mirror accounting');
});

test('confirmed copy close is independent of the leader close notice', async () => {
  const m = copy();
  feed().emit('mirror', closed(m));
  await flush();
  assert.equal(messages().length, 1);
  assert.equal(messages()[0].body, 'closed their automatic copy of BTC-PERP long');
  assert.equal(messages()[0].memberId, 'follower');
  assert.equal(messages()[0].markerId, `mirror:${m.id}`);
  assert.equal(repo.trades.get(m.tradeId)!.closedAt, null);
});

test('confirmed meme copies use the token symbol for both open and close', async () => {
  const m = copy(trade('nadfun'));
  const engine = feed();
  engine.emit('mirror', m);
  await flush();
  engine.emit('mirror', closed(m, { closeOid: null }));
  await flush();
  assert.deepEqual(messages().map((n) => n.body), ['opened an automatic copy of $MOE', 'closed their automatic copy of $MOE']);
  assert.ok(messages().every((n) => n.markerId === `mirror:${m.id}` && n.memberName === 'copyMember'));
});

test('pending, submitting, skipped, cancelled and failed snapshots never announce a trade', async () => {
  const symbol = mock.fn(async () => 'BTC-PERP');
  const engine = feed(symbol);
  const m = copy();
  for (const status of ['pending', 'submitting', 'skipped', 'cancelled', 'failed'] as MirrorStatus[]) {
    engine.emit('mirror', { ...m, status, closeRq: 301, error: 'failed after sending' });
  }
  engine.emit('mirror', { ...m, size: '0' });
  engine.emit('mirror', { ...m, size: null });
  await flush();
  assert.deepEqual(messages(), []);
  assert.equal(symbol.mock.callCount(), 0);
});

test('failed close snapshots do not post a close notice or repeat the open', async () => {
  const m = copy();
  const engine = feed();
  engine.emit('mirror', m);
  await flush();
  engine.emit('mirror', { ...m, closeRq: 301, error: 'close failed: order rejected' });
  engine.emit('mirror', { ...m, status: 'failed', closeRq: 301, error: 'close failed: order rejected' });
  await flush();
  assert.deepEqual(messages().map((n) => n.body), ['opened an automatic copy of BTC-PERP long']);
});

test('a first snapshot carrying a close failure is not a new copy open', async () => {
  const symbol = mock.fn(async () => 'BTC-PERP');
  feed(symbol).emit('mirror', copy(trade(), { error: 'close failed: no open position' }));
  await flush();
  assert.deepEqual(messages(), []);
  assert.equal(symbol.mock.callCount(), 0);
});

test('manual follower close reconciliation needs no engine close order reference', async () => {
  const m = copy();
  feed().emit('mirror', closed(m, { closeRq: null, closeOid: null, closeTx: null }));
  await flush();
  assert.equal(messages()[0].body, 'closed their automatic copy of BTC-PERP long');
  assert.equal(messages()[0].markerId, `mirror:${m.id}`);
});

test('already-exited reconciliation describes a prior exit without claiming a fresh close', async () => {
  const m = copy();
  const engine = feed();
  const exit = closed(m, { closeRq: null, closeOid: null, closeTx: null, error: 'member had already exited this position' });
  engine.emit('mirror', exit);
  await flush();
  engine.emit('mirror', closed(m));
  await flush();
  assert.deepEqual(messages().map((n) => n.body), ['had already exited their automatic copy of BTC-PERP long']);
});

test('copies stay in their recorded cult even when leader and follower share other cults', async () => {
  const engine = feed();
  const m = copy();
  engine.emit('mirror', m);
  engine.emit('mirror', closed(m));
  await flush();
  const rooms = getDb().prepare('SELECT DISTINCT room FROM chat_messages').all();
  assert.deepEqual(rooms.map((r) => r.room), [chat.cultRoom(cultA)]);
  for (const room of [chat.cultRoom(cultB), chat.cultRoom(cultOther), 'global', 'country:NG']) {
    assert.equal(chat.listMessages(room).messages.length, 0, room);
  }
  assert.throws(() => chat.openRoom(chat.cultRoom(cultA), 'outsider'), /no such room/);
});

test('repeated snapshots, adds and reductions produce one persistent notice per state', async () => {
  const m = copy();
  const engine = feed();
  for (let i = 0; i < 20; i++) engine.emit('mirror', { ...m, updatedAt: m.updatedAt + i, size: String(200 + i), error: 'capped: max_usd_per_trade' });
  await flush();
  for (let i = 0; i < 20; i++) engine.emit('mirror', closed(m, { updatedAt: m.updatedAt + 20 + i, size: '0', marginUsd: 0, notionalUsd: 0 }));
  await flush();
  assert.deepEqual(messages().map((n) => n.body), ['opened an automatic copy of BTC-PERP long', 'closed their automatic copy of BTC-PERP long']);
});

test('a fresh feed deduplicates persisted notices despite changed market symbols and names', async () => {
  const m = copy();
  const first = feed();
  first.emit('mirror', m);
  first.emit('mirror', closed(m));
  await flush();
  members.setUsername('follower', 'newCopyName');
  const symbol = mock.fn(async () => 'RENAMED-PERP');
  const restarted = feed(symbol);
  restarted.emit('mirror', m);
  restarted.emit('mirror', closed(m, { error: 'member had already exited this position' }));
  await flush();
  assert.equal(messages().length, 2);
  assert.equal(symbol.mock.callCount(), 0, 'persisted duplicates need no market lookup');
});

test('slow market lookup does not block event emission and concurrent snapshots deduplicate', async () => {
  let resolveSymbol!: (value: string) => void;
  const lookup = new Promise<string>((resolve) => { resolveSymbol = resolve; });
  const engine = feed(mock.fn(() => lookup));
  const m = copy();
  for (let i = 0; i < 20; i++) assert.equal(engine.emit('mirror', { ...m }), true);
  assert.deepEqual(messages(), [], 'emit returns while the lookup is unresolved');
  resolveSymbol('BTC-PERP');
  await flush();
  assert.equal(messages().length, 1);
});

test('lookup errors are contained in the feed and a later snapshot can post the notice', async (t) => {
  const log = t.mock.method(console, 'warn', () => {});
  let fail = true;
  const engine = feed(mock.fn(async () => {
    if (fail) throw new Error('market unavailable');
    return 'BTC-PERP';
  }));
  const m = copy();
  assert.doesNotThrow(() => engine.emit('mirror', m));
  await flush();
  assert.deepEqual(messages(), []);
  assert.equal(log.mock.callCount(), 1);
  fail = false;
  engine.emit('mirror', m);
  await flush();
  assert.equal(messages().length, 1);
});

test('missing leader metadata is ignored without a lookup', async () => {
  const symbol = mock.fn(async () => 'BTC-PERP');
  feed(symbol).emit('mirror', copy(trade(), { tradeId: 'unknown' }));
  await flush();
  assert.deepEqual(messages(), []);
  assert.equal(symbol.mock.callCount(), 0);
});

test('followers without usernames use their own short wallet name', async () => {
  feed().emit('mirror', copy(trade(), { userId: 'unnamed' }));
  await flush();
  assert.equal(messages()[0].memberName, '0x4444\u20264444');
  assert.equal(messages()[0].text, '0x4444\u20264444 opened an automatic copy of BTC-PERP long');
});

test('original leader open, change and close notices keep their audience and wording', async () => {
  const t = trade('perpl', { cultIds: [cultA] });
  const engine = feed();
  engine.emit('trade', t);
  engine.emit('tradeChanged', t, 1.5);
  engine.emit('tradeClosed', { ...t, closedAt: Date.now() });
  await flush();
  assert.deepEqual(messages().map((n) => n.body), ['opened BTC-PERP long 5x', 'added 50% to BTC-PERP long 5x', 'closed BTC-PERP long 5x']);
  assert.ok(messages().every((n) => n.memberId === 'leader' && n.memberName === 'leaderName' && n.markerId === `trade:${t.id}`));
  assert.deepEqual(chat.listMessages(chat.cultRoom(cultB)).messages, []);
});
