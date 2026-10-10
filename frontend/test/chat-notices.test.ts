import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/lib/contracts';
import { uniqueChatNotices } from '../src/lib/chat-notices';

const message = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, room: 'cult:a', clanId: 'a', memberId: 'me', memberName: 'Trader', memberAvatarUrl: null, body: 'opened NEAR-PERP long 3x',
  text: 'Trader opened NEAR-PERP long 3x', kind: 'system', replyTo: null, markerId: 'trade:one',
  createdAt: new Date().toISOString(), ...patch,
});

test('old duplicated opening notices render once without hiding distinct entries', () => {
  assert.deepEqual(uniqueChatNotices([message('1'), message('2'), message('3', { markerId: 'trade:two' })]).map(m => m.id), ['1', '3']);
});

test('only terminal notices deduplicate, not adds, partial sells or member messages', () => {
  for (const body of ['sold 50% of NEAR-PERP long 3x', 'bought 50% more $MEME', 'added 50% to NEAR-PERP long 3x']) {
    assert.equal(uniqueChatNotices([message('1', { body }), message('2', { body })]).length, 2);
  }
  assert.equal(uniqueChatNotices([message('1', { kind: 'text' }), message('2', { kind: 'text' })]).length, 2);
  assert.equal(uniqueChatNotices([message('1'), message('2', { body: 'closed NEAR-PERP long 3x' }), message('3', { body: 'closed NEAR-PERP long 3x' })]).length, 2);
});
