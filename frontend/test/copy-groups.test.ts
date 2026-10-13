import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copiedPosition, copiersLabel, copyCardText, groupCopies } from '../src/lib/copyGroups';
import type { ChatMessage, CopyOf } from '../src/lib/contracts';

const lead: CopyOf = { tradeId: 't1', markerId: 'trade:t1', leaderId: 'daddy', leaderName: '23daddy' };
let n = 0;
const msg = (memberId: string, body: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${++n}`, room: 'cult:c1', kind: 'system', clanId: 'c1', memberId, memberName: memberId, memberAvatarUrl: null,
  body, text: `${memberId} ${body}`, replyTo: null, markerId: `mirror:${memberId}`, createdAt: new Date(1_790_000_000_000 + n * 1000).toISOString(), ...extra,
});

test('copies of one trade become one card, placed at the latest copy', () => {
  const opened = msg('daddy', 'opened SOL-PERP long 2x', { markerId: 'trade:t1' });
  const chat = msg('ada', 'nice entry', { kind: 'text', markerId: null });
  const copies = ['me', 'ada', 'bo', 'cy'].map(id => msg(id, 'opened an automatic copy of SOL-PERP long', { copyOf: lead }));
  const { shown, cards } = groupCopies([opened, copies[0]!, chat, ...copies.slice(1)]);
  assert.deepEqual(shown.map(m => m.id), [opened.id, chat.id, copies[3]!.id], 'one card, where the last copy landed');
  const card = cards.get(copies[3]!.id)!;
  assert.equal(card.copiers.length, 4);
  assert.equal(copyCardText(card, 'me'), "You and 3 others copied 23daddy's SOL-PERP long");
});

test('the wording reads naturally for one, two and many copiers', () => {
  const c = (...ids: string[]) => ids.map(id => ({ id, name: id === 'me' ? 'cult77' : id, avatarUrl: null }));
  assert.equal(copiersLabel(c('ada')), 'ada');
  assert.equal(copiersLabel(c('ada', 'me'), 'me'), 'You and ada');
  assert.equal(copiersLabel(c('ada', 'bo', 'cy', 'me'), 'me'), 'You and 3 others');
  assert.equal(copiersLabel(c('ada', 'bo')), 'ada and bo');
});

test('copies opening and copies closing are separate cards; the leader sees "your"', () => {
  const opens = ['ada', 'bo'].map(id => msg(id, 'opened an automatic copy of SOL-PERP long', { copyOf: lead }));
  const closes = ['ada', 'bo'].map(id => msg(id, 'closed their automatic copy of SOL-PERP long', { copyOf: lead }));
  const { shown, cards } = groupCopies([...opens, ...closes]);
  assert.equal(shown.length, 2);
  assert.equal(copyCardText(cards.get(opens[1]!.id)!, 'daddy'), "ada and bo copied your SOL-PERP long");
  assert.equal(copyCardText(cards.get(closes[1]!.id)!, 'me'), "ada and bo closed their copies of 23daddy's SOL-PERP long");
});

test('notices without a trade link (old or after the mainnet switch) stay as they were', () => {
  const old = msg('ada', 'opened an automatic copy of SOL-PERP long');
  const { shown, cards } = groupCopies([old]);
  assert.deepEqual(shown, [old]);
  assert.equal(cards.size, 0);
});

test("demo wording: the position comes out of \"auto-copied 23daddy's SOL-PERP long 2x with $10.00\"", () => {
  assert.equal(copiedPosition("auto-copied 23daddy's SOL-PERP long 2x with $10.00"), 'SOL-PERP long 2x');
  assert.equal(copiedPosition('opened an automatic copy of SOL-PERP long'), 'SOL-PERP long');
});
