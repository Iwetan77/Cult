import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFailureFromEvent, perpsCopyReady } from '../src/lib/copyStatus';

test('perp copying requires the account, enrolled key and forwarding', () => {
  assert.equal(perpsCopyReady(undefined), false);
  for (const perpl of [
    { accountId: null, keyEnrolled: true, forwarding: true },
    { accountId: '42', keyEnrolled: false, forwarding: true },
    { accountId: '42', keyEnrolled: true, forwarding: false },
  ]) assert.equal(perpsCopyReady(perpl), false);
  assert.equal(perpsCopyReady({ accountId: '42', keyEnrolled: true, forwarding: true }), true);
});

const failure = { id: 'copy-1', clanId: 'cult-1', userId: 'me', status: 'cancelled', error: 'Enable perps first' };

test('only this member\'s copy failures in this cult are displayed', () => {
  assert.deepEqual(copyFailureFromEvent(JSON.stringify(failure), 'me', 'cult-1'), { id: 'copy-1', clanId: 'cult-1', reason: 'Enable perps first' });
  assert.equal(copyFailureFromEvent(JSON.stringify(failure), 'someone-else', 'cult-1'), null);
  assert.equal(copyFailureFromEvent(JSON.stringify(failure), 'me', 'cult-2'), null);
  assert.equal(copyFailureFromEvent(JSON.stringify(failure), undefined, 'cult-1'), null);
});

test('pending, retries, successful and malformed events are not failures', () => {
  for (const status of ['pending', 'submitting', 'open', 'done', 'closed', 'skipped']) {
    assert.equal(copyFailureFromEvent(JSON.stringify({ ...failure, status }), 'me', 'cult-1'), null);
  }
  for (const data of ['{', 'null', '[]', '{}']) assert.equal(copyFailureFromEvent(data, 'me', 'cult-1'), null);
});

test('deliberately disabling exit following does not show a failed-copy alert', () => {
  assert.equal(copyFailureFromEvent(JSON.stringify({ ...failure, error: 'member turned off Follow exits' }), 'me', 'cult-1'), null);
});
