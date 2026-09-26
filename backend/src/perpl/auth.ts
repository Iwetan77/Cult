import { createHash, randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { env } from '../config/env.js';

// A Perpl API key: the opaque X-API-Key token plus the Ed25519 private key that
// signs every request. Scope is fixed at enrollment; `trade` can place/cancel
// orders but Perpl never lets an API key withdraw or transfer out.
export interface ApiKeyCredentials {
  apiKey: string;
  secret: Uint8Array; // 32-byte Ed25519 private key
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const nonce = () => randomBytes(16).toString('base64url');

export async function signRestHeaders(
  creds: ApiKeyCredentials,
  method: string,
  target: string, // path + query exactly as sent, without the /api prefix
  body = '',
): Promise<Record<string, string>> {
  const timestamp = Date.now().toString();
  const n = nonce();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = [env.chainId, method, target, timestamp, n, bodyHash].join('\n');
  const sig = await ed.signAsync(Buffer.from(canonical), creds.secret);
  return {
    'X-API-Key': creds.apiKey,
    'X-API-Timestamp': timestamp,
    'X-API-Nonce': n,
    'X-API-Signature': b64url(sig),
  };
}

export async function wsSignInFrame(creds: ApiKeyCredentials) {
  const timestamp = Date.now().toString();
  const n = nonce();
  const canonical = [env.chainId, 'trading-ws-signin', timestamp, n].join('\n');
  const sig = await ed.signAsync(Buffer.from(canonical), creds.secret);
  return {
    mt: 29,
    chain_id: env.chainId,
    api_key: creds.apiKey,
    timestamp,
    nonce: n,
    signature: b64url(sig),
  };
}

export function newEd25519Key(): { secret: Uint8Array; publicKeyHexPromise: Promise<string> } {
  const secret = ed.utils.randomSecretKey();
  const publicKeyHexPromise = ed.getPublicKeyAsync(secret).then((pk) => '0x' + Buffer.from(pk).toString('hex'));
  return { secret, publicKeyHexPromise };
}
