import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

const { tradeStateOf } = await import('../src/api/chat.js');
const { trades } = await import('../src/mirror/repo.js');
const { members } = await import('../src/store/members.js');
const db = await import('../src/store/db.js');

test('a trade card knows if its trade is open, closed, or gone after the mainnet switch', () => {
  members.upsert('u1', '0x00000000000000000000000000000000000000a1');
  trades.insert({ id: 'tc1', venue: 'perpl', userId: 'u1', accountId: 1, market: '16', side: 'long', positionId: 1, size: '1', entryPrice: 100, leverage: 500, marginFraction: 0.1, openTx: '0xT1', openedAt: Date.now() });
  assert.equal(tradeStateOf('trade:tc1'), 'open');
  trades.markClosed('tc1');
  assert.equal(tradeStateOf('trade:tc1'), 'closed');
  assert.equal(tradeStateOf('trade:nope'), 'gone');
  assert.equal(tradeStateOf('mirror:nope'), 'gone');
  assert.equal(tradeStateOf('stack:nope'), 'gone');
  // Not about a trade.
  assert.equal(tradeStateOf(null), null);
  assert.equal(tradeStateOf('cult:abc'), null);
  assert.equal(tradeStateOf('chart:abc'), null);
  // The switch wipes trading state; the card's trade is gone, not an error.
  db.switchChain(db.getDb(), 143);
  assert.equal(tradeStateOf('trade:tc1'), 'gone');
});

test('a copy notice says which trade and whose it copied, so copies group into one card', async () => {
  const { copyOfMarker } = await import('../src/api/chat.js');
  const { mirrors } = await import('../src/mirror/repo.js');
  const { clans } = await import('../src/store/clans.js');
  members.upsert('leader1', '0x00000000000000000000000000000000000000b1');
  members.upsert('fan1', '0x00000000000000000000000000000000000000b2');
  const clanId = clans.create('night shift', 'leader1').id;
  clans.join(clanId, 'fan1');
  trades.insert({ id: 'tc2', venue: 'perpl', userId: 'leader1', accountId: 2, market: '48', side: 'long', positionId: 2, size: '1', entryPrice: 150, leverage: 200, marginFraction: 0.5, openTx: '0xT2', openedAt: Date.now() });
  const m = mirrors.insertPending({ tradeId: 'tc2', clanId, userId: 'fan1', skipUntil: Date.now() });
  const copy = copyOfMarker(`mirror:${m.id}`);
  assert.equal(copy?.tradeId, 'tc2');
  assert.equal(copy?.markerId, 'trade:tc2');
  assert.equal(copy?.leaderId, 'leader1');
  assert.ok(copy?.leaderName);
  assert.equal(copyOfMarker('trade:tc2'), null, "a leader's own notice isn't a copy");
  assert.equal(copyOfMarker('mirror:missing'), null);
  assert.equal(copyOfMarker(null), null);
});
