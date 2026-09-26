// Spike B: walk the documented API-key enrollment flow against the real API.
// With SPIKE_WALLET_PRIVATE_KEY unset it uses a fresh random wallet, which is
// expected to die at /enroll with 404 (no Perpl account yet). That 404 is the
// point where a funded wallet + createAccount is needed.
import { ethers } from 'ethers';
import * as ed from '@noble/ed25519';
import { env } from '../../src/config/env.js';

const wallet = process.env.SPIKE_WALLET_PRIVATE_KEY
  ? new ethers.Wallet(process.env.SPIKE_WALLET_PRIVATE_KEY)
  : ethers.Wallet.createRandom();

const priv = ed.utils.randomSecretKey();
const pubHex = '0x' + Buffer.from(await ed.getPublicKeyAsync(priv)).toString('hex');

const payloadRes = await fetch(`${env.perplApiUrl}/v1/api-key/payload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chain_id: env.chainId, address: wallet.address, public_key: pubHex, scope_mask: 2, label: 'cult-spike' }),
});
console.log('payload', payloadRes.status);
if (!payloadRes.ok) throw new Error(await payloadRes.text());
const { typed_data, mac } = (await payloadRes.json()) as { typed_data: any; mac: string };
console.log('statement the user signs:', typed_data.message.statement);

const { EIP712Domain: _d, ...types } = typed_data.types;
const signature = await wallet.signTypedData(typed_data.domain, types, typed_data.message);
const digest = ethers.TypedDataEncoder.hash(typed_data.domain, types, typed_data.message);
const pop = '0x' + Buffer.from(await ed.signAsync(ethers.getBytes(digest), priv)).toString('hex');

const enrollRes = await fetch(`${env.perplApiUrl}/v1/api-key/enroll`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chain_id: env.chainId, address: wallet.address, typed_data, mac, signature, pop_signature: pop }),
});
console.log('enroll', enrollRes.status, (await enrollRes.text()).slice(0, 300));
