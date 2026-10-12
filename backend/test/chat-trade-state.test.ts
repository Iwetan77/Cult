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
