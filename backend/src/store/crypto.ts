import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { required } from '../config/env.js';

// Member API-key secrets are the one thing in the DB that can move money
// (trade, never withdraw), so they're sealed with AES-256-GCM under
// KEY_ENCRYPTION_SECRET. Format: iv(12) | tag(16) | ciphertext, base64.
function key(): Buffer {
  const k = Buffer.from(required('KEY_ENCRYPTION_SECRET'), 'hex');
  if (k.length !== 32) throw new Error('KEY_ENCRYPTION_SECRET must be 32 bytes hex');
  return k;
}

export function seal(plain: Uint8Array): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function unseal(sealed: string): Uint8Array {
  const buf = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return new Uint8Array(Buffer.concat([d.update(buf.subarray(28)), d.final()]));
}
