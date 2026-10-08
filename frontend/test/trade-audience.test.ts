import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tradeAudienceNotice } from '../src/lib/tradeAudience';

const cults = [
  { id: 'a', name: 'Alpha', isOwner: true, isAdmin: true },
  { id: 'b', name: 'Beta', isOwner: false, isAdmin: true },
  { id: 'c', name: 'Gamma', isOwner: false, isAdmin: false },
];
test('private trades are never announced as shared', () => {
  assert.equal(tradeAudienceNotice(cults, []), 'Not posted to a cult.');
});
test('members with no eligible cults get a private completion message', () => {
  assert.equal(tradeAudienceNotice([]), 'Not posted to a cult.');
  assert.equal(tradeAudienceNotice([cults[2]!]), 'Not posted to a cult.');
});
test('only eligible selected cults are named', () => {
  assert.equal(tradeAudienceNotice(cults, ['b']), 'Posted to Beta.');
  assert.equal(tradeAudienceNotice(cults, ['c']), 'Not posted to a cult.');
  assert.equal(tradeAudienceNotice(cults, ['missing']), 'Not posted to a cult.');
});
test('the default counts admin cults, not every membership', () => {
  assert.equal(tradeAudienceNotice(cults), 'Posted to 2 cults.');
});
