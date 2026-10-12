import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explain, explainCopy, looksTechnical, memberView, perplOrderProblem, sentence } from '../src/errors/friendly.js';

const RAW = /rq=|st=|sr=|fr=|Error:|0x[0-9a-f]{6,}|not retried/i;

test('the copy failure from the bug report reads as plain words', () => {
  const stored = 'failed after sending, not retried: Error: order rq=1791767686885 failed: st=7 sr=44 fr=2';
  const why = explainCopy(stored, true);
  assert.equal(why.code, 'needs_margin');
  assert.doesNotMatch(why.message, RAW);
  const view = memberView({ status: 'failed', error: stored });
  assert.equal(view.errorCode, 'needs_margin');
  assert.doesNotMatch(view.error!, RAW);
});

test('every Perpl reason code maps to a sentence with no codes in it', () => {
  for (let sr = 0; sr <= 70; sr++) {
    for (const fr of [null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const why = perplOrderProblem(sr, fr);
      assert.ok(why.code && why.message.length > 10, `sr=${sr} fr=${fr}`);
      assert.doesNotMatch(why.message, RAW);
      assert.equal(looksTechnical(why.message), false, why.message);
    }
  }
});

test('a partly filled order never says try again', () => {
  const why = perplOrderProblem(44, 2, true);
  assert.equal(why.code, 'order_partial');
  assert.doesNotMatch(why.message, /try again/i);
});

test('engine reasons for skipped copies become plain words', () => {
  const cases: [string, string][] = [
    ['Perpl setup not finished: enroll your trading key', 'needs_setup'],
    ['backend signer is on an outdated policy (re-approve your caps)', 'needs_permission'],
    ['leader trade detected 42s late (backend was catching up); not mirrored at a stale price', 'too_late'],
    ['leader closed before mirror fired', 'leader_closed'],
    ['interrupted by a restart before sending; too late to copy now', 'restarted'],
    ['not sized: mirror size $0.40 is under the $1 minimum', 'too_small'],
    ['copy order did not fill', 'no_fill'],
    ['member left the clan', 'not_member'],
    ['Signer had insufficient balance for gas', 'needs_gas'],
  ];
  for (const [raw, code] of cases) {
    const view = memberView({ status: 'cancelled', error: raw });
    assert.equal(view.errorCode, code, raw);
    assert.doesNotMatch(view.error!, /clan|leader|mirror|Perpl setup|backend|sized/i, raw);
  }
});

test('member choices and unknown internals', () => {
  assert.equal(memberView({ status: 'cancelled', error: 'member turned off Follow exits' }).error, 'member turned off Follow exits');
  assert.equal(memberView({ status: 'pending', error: 'retrying (1/3): fetch failed' }).errorCode, 'retrying');
  assert.equal(memberView({ status: 'open', error: null }).error, null);
  // An unknown failure still gets a sentence, and one that was sent can't promise nothing traded.
  assert.equal(explainCopy('TypeError: x is undefined', false).code, 'copy_failed');
  assert.equal(explainCopy('failed after sending, not retried: weird', true).code, 'copy_unconfirmed');
  assert.equal(explain(''), null);
  assert.equal(sentence('slow down a little'), 'Slow down a little.');
});

test('no MON for fees: testnet points at the free faucet, mainnet asks for a deposit', async () => {
  const { gasMessage } = await import('../src/errors/friendly.js');
  assert.match(gasMessage(10143), /faucet\.monad\.xyz/);
  assert.doesNotMatch(gasMessage(143), /faucet|testnet/);
  assert.match(gasMessage(143), /Deposit some MON/);
});
