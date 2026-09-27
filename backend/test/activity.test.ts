import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);
const { describeTrade } = await import('../src/api/activity.js');

const perp = { venue: 'perpl', side: 'long', leverage: 500 } as any;
const meme = { venue: 'nadfun', side: 'buy', leverage: 100 } as any;

test('activity lines read like a trader talking', () => {
  assert.equal(describeTrade(perp, 'opened', 'BTC-PERP'), 'opened BTC-PERP long 5x');
  assert.equal(describeTrade(perp, 'changed', 'BTC-PERP', 1.5), 'added 50% to BTC-PERP long 5x');
  assert.equal(describeTrade(perp, 'changed', 'BTC-PERP', 0.25), 'sold 75% of BTC-PERP long 5x');
  assert.equal(describeTrade(perp, 'closed', 'BTC-PERP'), 'closed BTC-PERP long 5x');
  assert.equal(describeTrade(meme, 'opened', '$MOE'), 'bought $MOE');
  assert.equal(describeTrade(meme, 'changed', '$MOE', 2), 'bought 100% more $MOE');
  assert.equal(describeTrade(meme, 'changed', '$MOE', 0.5), 'sold 50% of $MOE');
  assert.equal(describeTrade(meme, 'closed', '$MOE'), 'sold all $MOE');
});
