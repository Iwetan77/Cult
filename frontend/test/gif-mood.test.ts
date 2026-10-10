import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moodOf } from '../src/lib/giphy';

test('any loss gets a losing GIF, however small', () => {
  assert.equal(moodOf(-0.2, -0.02), 'loss', 'the card in the bug report: -0.2% used to shrug with a thumbs up');
  assert.equal(moodOf(-7.8, -0.78), 'loss');
  assert.equal(moodOf(-40, -4), 'rekt');
});

test('any gain celebrates, a big one more so', () => {
  assert.equal(moodOf(0.3, 0.03), 'win');
  assert.equal(moodOf(12, 1.2), 'win');
  assert.equal(moodOf(60, 6), 'moon');
});

test('only an even trade shrugs; without a return, the PnL sign decides', () => {
  assert.equal(moodOf(0, 0), 'flat');
  assert.equal(moodOf(null, -5), 'loss');
  assert.equal(moodOf(null, 5), 'win');
  assert.equal(moodOf(null, null), 'flat');
});
