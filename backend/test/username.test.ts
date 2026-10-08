import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

let members: typeof import('../src/store/members.js')['members'];
let names: typeof import('../src/api/names.js');

before(async () => {
  ({ members } = await import('../src/store/members.js'));
  names = await import('../src/api/names.js');
  members.upsert('U', `0x${'1'.repeat(40)}`);
});

test('the first pick is free; a change starts a 3-month wait', () => {
  members.setUsername('U', 'first_pick');
  assert.equal(names.nextUsernameChange(members.get('U')!), null, 'picking at sign-in does not count');
  members.setUsername('U', 'second', true);
  const m = members.get('U')!;
  assert.ok(m.usernameChangedAt, 'a change is dated');
  const next = names.nextUsernameChange(m)!;
  const expected = new Date(m.usernameChangedAt!);
  expected.setUTCMonth(expected.getUTCMonth() + names.USERNAME_CHANGE_MONTHS);
  assert.equal(next, expected.getTime(), 'next change: three calendar months later');
  assert.equal(names.nextUsernameChange(m, next + 1), null, 'allowed again once the wait is over');
});
