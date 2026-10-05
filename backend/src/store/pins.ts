import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { required } from '../config/env.js';
import { getDb } from './db.js';

// A 4-digit PIN each member sets right after signing in, asked again before
// money leaves Cult (withdrawals, here or to another chain). Privy's own
// confirmation screens are off, so this is the second factor on a phone
// someone else picks up.
//
// Ten thousand PINs are easy to guess offline, so the stored hash is keyed:
// HMAC with KEY_ENCRYPTION_SECRET (and the member id), then scrypt with a
// salt. A copy of the database alone can't be brute-forced. Online, five
// wrong tries lock the PIN for 15 minutes.

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export class PinError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 423, message: string, readonly code: 'pin_invalid' | 'pin_weak' | 'pin_required' | 'pin_missing' | 'pin_wrong' | 'pin_locked') {
    super(message);
  }
}

const keyed = (userId: string, pin: string) => createHmac('sha256', Buffer.from(required('KEY_ENCRYPTION_SECRET'), 'hex')).update(`${userId}:${pin}`).digest();
const hashPin = (userId: string, pin: string) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(keyed(userId, pin), salt, 32).toString('base64')}`;
};
const matches = (userId: string, pin: string, stored: string) => {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  return timingSafeEqual(scryptSync(keyed(userId, pin), Buffer.from(salt, 'base64'), want.length), want);
};

// 0000, 1111, 1234, 9876 and the like.
export function weakPin(pin: string): boolean {
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]!);
  return steps.every((s) => s === 0) || steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

function validate(pin: unknown): string {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw new PinError(400, 'Your PIN is 4 digits.', 'pin_invalid');
  if (weakPin(pin)) throw new PinError(400, 'Pick a PIN that is harder to guess than that.', 'pin_weak');
  return pin;
}

interface Row { pin_hash: string | null; pin_failures: number; pin_locked_until: number | null }
const row = (userId: string) =>
  getDb().prepare('SELECT pin_hash, pin_failures, pin_locked_until FROM members WHERE user_id = ?').get(userId) as Row | undefined;
const store = (userId: string, hash: string | null, failures: number, lockedUntil: number | null) =>
  getDb().prepare('UPDATE members SET pin_hash = ?, pin_failures = ?, pin_locked_until = ? WHERE user_id = ?').run(hash, failures, lockedUntil, userId);

export const pins = {
  isSet(userId: string): boolean {
    return !!row(userId)?.pin_hash;
  },

  // Is this the member's PIN? Wrong tries count toward the lock; a right one
  // clears them.
  check(userId: string, pin: unknown, now = Date.now()) {
    const r = row(userId);
    if (!r?.pin_hash) throw new PinError(409, 'Set your PIN first.', 'pin_required');
    // No PIN sent at all is a request to ask for it, not a wrong try.
    if (pin == null || pin === '') throw new PinError(400, 'Enter your PIN.', 'pin_missing');
    if (r.pin_locked_until != null && r.pin_locked_until > now) {
      const minutes = Math.ceil((r.pin_locked_until - now) / 60_000);
      throw new PinError(423, `Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'pin_locked');
    }
    if (typeof pin === 'string' && /^\d{4}$/.test(pin) && matches(userId, pin, r.pin_hash)) {
      if (r.pin_failures || r.pin_locked_until) store(userId, r.pin_hash, 0, null);
      return;
    }
    const failures = (r.pin_locked_until != null ? 0 : r.pin_failures) + 1;
    if (failures >= MAX_FAILURES) {
      store(userId, r.pin_hash, 0, now + LOCK_MS);
      throw new PinError(423, 'Too many wrong tries. Your PIN is locked for 15 minutes.', 'pin_locked');
    }
    store(userId, r.pin_hash, failures, null);
    const left = MAX_FAILURES - failures;
    throw new PinError(403, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`, 'pin_wrong');
  },

  // First PIN, or a change (which needs the current one).
  set(userId: string, pin: unknown, currentPin?: unknown) {
    const next = validate(pin);
    if (this.isSet(userId)) pins.check(userId, currentPin);
    store(userId, hashPin(userId, next), 0, null);
  },

  // Forgot it: the caller has checked the member just signed in again.
  reset(userId: string, pin: unknown) {
    store(userId, hashPin(userId, validate(pin)), 0, null);
  },
};
