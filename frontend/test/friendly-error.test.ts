import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../src/lib/friendlyError';
import { copyFailureFromEvent } from '../src/lib/copyStatus';

test('legacy technical copy failures never reach the screen', () => {
  const raw = 'failed after sending, not retried: Error: order rq=1791767686885 failed: st=7 sr=44 fr=2';
  const failure = copyFailureFromEvent(JSON.stringify({ id: 'copy-1', userId: 'me', clanId: 'cult-1', status: 'failed', error: raw }), 'me', 'cult-1');
  assert.ok(failure);
  assert.doesNotMatch(failure.reason, /Error:|rq=|st=|sr=|fr=/);
  assert.match(failure.reason, /Check|try/i);
});

test('safe backend detail wins over a generic code mapping', () => {
  const message = 'Your SOL position is down $0.55. Lower the leverage or add more margin.';
  assert.equal(friendlyError({ code: 'needs_margin', status: 409, message }), message);
  assert.match(friendlyError({ code: 'needs_margin', message: 'Error: order rq=12' }), /Add funds/);
});

test('access, rate limits and expired sessions have distinct guidance', () => {
  assert.equal(friendlyError({ status: 403, message: 'Only the cult owner can change admins.' }), 'Only the cult owner can change admins.');
  assert.equal(friendlyError({ status: 409, message: 'That username is taken.' }), 'That username is taken.');
  assert.match(friendlyError({ status: 429, retryAfterSeconds: 7 }), /7s/);
  assert.match(friendlyError({ status: 401, code: 'signed_out' }), /Sign in again/);
});

test('wallet rejection, network and gas errors never expose provider text', () => {
  assert.match(friendlyError(new Error('User rejected the request')), /cancelled/);
  assert.match(friendlyError(new Error('chain mismatch: 10143')), /Switch/);
  assert.match(friendlyError(new Error('insufficient funds for gas * price')), /Add MON/);
});

test('retrying and capped copy events do not become failure banners', () => {
  for (const errorCode of ['retrying', 'capped']) {
    const value = { id: 'copy-1', userId: 'me', clanId: 'cult-1', status: 'failed', errorCode, error: 'pending' };
    assert.equal(copyFailureFromEvent(JSON.stringify(value), 'me', 'cult-1'), null);
  }
});
