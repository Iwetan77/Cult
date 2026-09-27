import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numEnv, strEnv } from '../src/config/env.js';

test('blank or junk settings fall back to the default, never 0 or ""', () => {
  process.env.T_NUM = '';
  assert.equal(numEnv('T_NUM', 240), 240);
  process.env.T_NUM = '  ';
  assert.equal(numEnv('T_NUM', 240), 240);
  process.env.T_NUM = 'abc';
  assert.equal(numEnv('T_NUM', 240), 240);
  process.env.T_NUM = '0.5';
  assert.equal(numEnv('T_NUM', 240), 0.5);
  delete process.env.T_NUM;
  assert.equal(numEnv('T_NUM', 7), 7);
  process.env.T_STR = '';
  assert.equal(strEnv('T_STR', 'https://x'), 'https://x');
});

test('invite codes are ABC-DEF, and typed codes are forgiven', async () => {
  const { newInviteCode, normalizeInviteCode } = await import('../src/store/clans.js');
  for (let i = 0; i < 50; i++) assert.match(newInviteCode(), /^[A-Z]{3}-[A-Z]{3}$/);
  assert.equal(normalizeInviteCode('abcdef'), 'ABC-DEF');
  assert.equal(normalizeInviteCode(' abc - def '), 'ABC-DEF');
  assert.equal(normalizeInviteCode('ABC-DEF'), 'ABC-DEF');
  assert.equal(normalizeInviteCode('Xy_3kLmN'), 'Xy_3kLmN', 'legacy codes pass through untouched');
});
