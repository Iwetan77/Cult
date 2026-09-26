import { ethers } from 'ethers';
import * as ed from '@noble/ed25519';
import { env } from '../config/env.js';
import type { Eip712TypedData, WalletSigner } from '../chain/signer.js';
import { newEd25519Key, type ApiKeyCredentials } from './auth.js';

export const SCOPE_READ = 1;
export const SCOPE_TRADE = 2; // implies read

export interface EnrolledKey extends ApiKeyCredentials {
  publicKey: string;
  scopeMask: number;
  owner: string;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Perpl checks Origin against a whitelist. Server-side we either send the
  // whitelisted origin we've been given, or none (which the testnet accepts).
  if (env.perplOrigin) headers.Origin = env.perplOrigin;
  const res = await fetch(`${env.perplApiUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 404 && path.endsWith('/enroll')
        ? ' (no Perpl profile for this wallet yet: createAccount first)'
        : res.status === 423
          ? ' (wallet already has 16 active keys)'
          : '';
    throw new Error(`perpl ${path} -> ${res.status}${hint}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// Enroll a fresh Ed25519 key for `signer`'s Perpl account. The member's wallet
// signs the EIP-712 payload once (this is the one-time authorization), the new
// key signs the proof-of-possession, and the backend keeps the private half.
// That key can trade the account but can never withdraw from it.
export async function enrollApiKey(signer: WalletSigner, label: string, scopeMask = SCOPE_TRADE): Promise<EnrolledKey> {
  const { secret, publicKeyHexPromise } = newEd25519Key();
  const publicKey = await publicKeyHexPromise;

  const { typed_data, mac } = (await post('/v1/api-key/payload', {
    chain_id: env.chainId,
    address: signer.address,
    public_key: publicKey,
    scope_mask: scopeMask,
    label,
  })) as { typed_data: Eip712TypedData; mac: string };

  const signature = await signer.signTypedData(typed_data);
  const { EIP712Domain: _omit, ...types } = typed_data.types;
  const digest = ethers.TypedDataEncoder.hash(typed_data.domain as ethers.TypedDataDomain, types, typed_data.message);
  const pop = '0x' + Buffer.from(await ed.signAsync(ethers.getBytes(digest), secret)).toString('hex');

  const { api_key } = (await post('/v1/api-key/enroll', {
    chain_id: env.chainId,
    address: signer.address,
    typed_data,
    mac,
    signature,
    pop_signature: pop,
  })) as { api_key: { api_key: string; scope_mask: number } };

  return { apiKey: api_key.api_key, secret, publicKey, scopeMask: api_key.scope_mask, owner: signer.address };
}
