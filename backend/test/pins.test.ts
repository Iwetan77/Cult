// The member PIN: set once, checked before money leaves, five wrong tries
// lock it for 15 minutes, a change needs the current one, and the stored
// value is a keyed hash, never the PIN.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

let pins: typeof import('../src/store/pins.js')['pins'];
let P: typeof import('../src/store/pins.js');
let getDb: typeof import('../src/store/db.js')['getDb'];

before(async () => {
  P = await import('../src/store/pins.js');
  pins = P.pins;
  getDb = (await import('../src/store/db.js')).getDb;
  const { members } = await import('../src/store/members.js');
  members.upsert('did:privy:pin-a', '0x00000000000000000000000000000000000000a1');
  members.upsert('did:privy:pin-b', '0x00000000000000000000000000000000000000b2');
});

const code = (fn: () => void) => { try { fn(); return 'ok'; } catch (e) { if (e instanceof P.PinError) return e.code; throw e; } };

test('weak PINs are refused, and only 4 digits', () => {
  for (const pin of ['0000', '7777', '1234', '6789', '9876', '3210']) assert.equal(P.weakPin(pin), true, pin);
  for (const pin of ['4826', '1357', '2580', '0101']) assert.equal(P.weakPin(pin), false, pin);
  assert.equal(code(() => pins.set('did:privy:pin-a', '1234')), 'pin_weak');
  assert.equal(code(() => pins.set('did:privy:pin-a', '482')), 'pin_invalid');
  assert.equal(code(() => pins.set('did:privy:pin-a', '48a6')), 'pin_invalid');
  assert.equal(pins.isSet('did:privy:pin-a'), false);
});

test('before a PIN is set, a check asks for one', () => {
  assert.equal(code(() => pins.check('did:privy:pin-a', '4826')), 'pin_required');
});

test('set, then right and wrong PINs; the PIN itself is never stored', () => {
  pins.set('did:privy:pin-a', '4826');
  assert.equal(pins.isSet('did:privy:pin-a'), true);
  const stored = (getDb().prepare('SELECT pin_hash FROM members WHERE user_id = ?').get('did:privy:pin-a') as { pin_hash: string }).pin_hash;
  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes('4826'));
  assert.equal(code(() => pins.check('did:privy:pin-a', '4826')), 'ok');
  assert.equal(code(() => pins.check('did:privy:pin-a', '4827')), 'pin_wrong');
  assert.equal(code(() => pins.check('did:privy:pin-a', undefined)), 'pin_missing'); // not counted
  assert.equal(code(() => pins.check('did:privy:pin-a', '4826')), 'ok'); // a right one clears the count
});

test('the same PIN hashes differently per member (salt + member key)', () => {
  pins.set('did:privy:pin-b', '4826');
  const rows = getDb().prepare("SELECT pin_hash FROM members WHERE user_id IN ('did:privy:pin-a', 'did:privy:pin-b')").all() as { pin_hash: string }[];
  assert.notEqual(rows[0]!.pin_hash, rows[1]!.pin_hash);
  assert.equal(code(() => pins.check('did:privy:pin-b', '4826')), 'ok');
});

test('five wrong tries lock it for 15 minutes, even for the right PIN', () => {
  const now = Date.now();
  for (let i = 1; i <= 4; i++) assert.equal(code(() => pins.check('did:privy:pin-b', '1111', now)), 'pin_wrong', `try ${i}`);
  assert.equal(code(() => pins.check('did:privy:pin-b', '1111', now)), 'pin_locked');
  assert.equal(code(() => pins.check('did:privy:pin-b', '4826', now + 60_000)), 'pin_locked');
  assert.equal(code(() => pins.check('did:privy:pin-b', '4826', now + P.LOCK_MS + 1)), 'ok');
});

test('a change needs the current PIN; a reset (after signing in again) does not', () => {
  assert.equal(code(() => pins.set('did:privy:pin-a', '5937')), 'pin_missing');
  assert.equal(code(() => pins.set('did:privy:pin-a', '5937', '0007')), 'pin_wrong');
  assert.equal(code(() => pins.set('did:privy:pin-a', '5937', '4826')), 'ok');
  assert.equal(code(() => pins.check('did:privy:pin-a', '5937')), 'ok');
  pins.reset('did:privy:pin-a', '2580');
  assert.equal(code(() => pins.check('did:privy:pin-a', '2580')), 'ok');
  assert.equal(code(() => pins.check('did:privy:pin-a', '5937')), 'pin_wrong');
});
