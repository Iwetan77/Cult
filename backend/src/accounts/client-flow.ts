import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import * as ed from '@noble/ed25519';
import { env } from '../config/env.js';
import { collateralBalance, erc20Abi, exchangeAbi, getOnChainAccount } from '../chain/exchange.js';
import { rpc, type Eip712TypedData } from '../chain/signer.js';
import { newEd25519Key } from '../perpl/auth.js';
import { getExchangeInfo } from '../perpl/context.js';
import { SCOPE_TRADE } from '../perpl/enroll.js';
import { PerplRest } from '../perpl/rest.js';
import { members } from '../store/members.js';

// The browser-side version of onboardMember: the member's Privy embedded wallet
// signs in the client, the backend only prepares what to sign and finishes the
// Perpl enrollment. Same three steps, same order.

export type SetupStep = 'needs_collateral' | 'needs_account' | 'needs_key' | 'needs_forwarding' | 'ready';

export interface WalletAction {
  to: string;
  data: string;
  value?: string;
  chainId: number;
  label: string;
}

export interface SetupStatus {
  step: SetupStep;
  wallet: string;
  perplAccountId: number | null;
  collateralBalance: string; // raw AUSD units
  minAccountOpen: string;
  actions: WalletAction[]; // send in order, then GET status again
}

export async function setupStatus(userId: string, depositRaw?: bigint): Promise<SetupStatus> {
  const m = members.get(userId);
  if (!m) throw new Error('unknown member');
  const info = await getExchangeInfo();
  const [onchain, bal] = await Promise.all([getOnChainAccount(m.wallet), collateralBalance(m.wallet)]);
  const base = {
    wallet: m.wallet,
    perplAccountId: onchain ? Number(onchain.accountId) : null,
    collateralBalance: bal.toString(),
    minAccountOpen: info.minAccountOpen.toString(),
  };

  if (!onchain) {
    const amount = depositRaw && depositRaw > info.minAccountOpen ? depositRaw : info.minAccountOpen;
    if (bal < amount) return { ...base, step: 'needs_collateral', actions: [] };
    const allowance: bigint = await new ethers.Contract(info.collateralToken, erc20Abi, rpc()).getFunction('allowance')(m.wallet, info.exchange);
    const actions: WalletAction[] = [];
    if (allowance < amount) {
      actions.push({
        to: info.collateralToken,
        data: erc20Abi.encodeFunctionData('approve', [info.exchange, amount]),
        chainId: env.chainId,
        label: 'approve',
      });
    }
    actions.push({ to: info.exchange, data: exchangeAbi.encodeFunctionData('createAccount', [amount]), chainId: env.chainId, label: 'createAccount' });
    return { ...base, step: 'needs_account', actions };
  }
  members.setAccount(userId, Number(onchain.accountId));

  const creds = members.credentials(userId);
  if (!creds) return { ...base, step: 'needs_key', actions: [] };

  const w = await new PerplRest(creds).wallet().catch(() => null);
  const acct = w?.as?.find((a) => a.id === Number(onchain.accountId));
  if (!acct?.fw) {
    return {
      ...base,
      step: 'needs_forwarding',
      actions: [
        { to: info.exchange, data: exchangeAbi.encodeFunctionData('allowOrderForwarding', [true]), chainId: env.chainId, label: 'allowOrderForwarding' },
      ],
    };
  }
  members.setForwarding(userId, true);
  return { ...base, step: 'ready', actions: [] };
}

// ---- api-key enrollment, split across two requests --------------------------

interface PendingEnrollment {
  userId: string;
  wallet: string;
  secret: Uint8Array;
  publicKey: string;
  typedData: Eip712TypedData;
  mac: string;
  expires: number;
}
const pendingEnrollments = new Map<string, PendingEnrollment>();
const ENROLL_TTL_MS = 10 * 60_000;

async function perplPost(path: string, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.perplOrigin) headers.Origin = env.perplOrigin;
  const res = await fetch(`${env.perplApiUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`perpl ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function startEnrollment(userId: string): Promise<{ challengeId: string; typedData: Eip712TypedData; expiresAt: string }> {
  const m = members.get(userId);
  if (!m?.perplAccountId) throw new Error('create the Perpl account before enrolling a key');
  const { secret, publicKeyHexPromise } = newEd25519Key();
  const publicKey = await publicKeyHexPromise;
  const { typed_data, mac } = await perplPost('/v1/api-key/payload', {
    chain_id: env.chainId,
    address: ethers.getAddress(m.wallet),
    public_key: publicKey,
    scope_mask: SCOPE_TRADE,
    label: 'cult',
  });
  const challengeId = randomUUID();
  const expires = Date.now() + ENROLL_TTL_MS;
  pendingEnrollments.set(challengeId, { userId, wallet: m.wallet, secret, publicKey, typedData: typed_data, mac, expires });
  return { challengeId, typedData: typed_data, expiresAt: new Date(expires).toISOString() };
}

export async function completeEnrollment(userId: string, challengeId: string, signature: string) {
  const p = pendingEnrollments.get(challengeId);
  if (!p || p.userId !== userId) throw new Error('unknown enrollment challenge');
  if (Date.now() > p.expires) {
    pendingEnrollments.delete(challengeId);
    throw new Error('enrollment challenge expired');
  }
  const { EIP712Domain: _omit, ...types } = p.typedData.types;
  const domain = p.typedData.domain as ethers.TypedDataDomain;
  const recovered = ethers.verifyTypedData(domain, types, p.typedData.message, signature);
  if (recovered.toLowerCase() !== p.wallet.toLowerCase()) throw new Error('signature is not from the member wallet');

  const digest = ethers.TypedDataEncoder.hash(domain, types, p.typedData.message);
  const pop = '0x' + Buffer.from(await ed.signAsync(ethers.getBytes(digest), p.secret)).toString('hex');
  const { api_key } = await perplPost('/v1/api-key/enroll', {
    chain_id: env.chainId,
    address: ethers.getAddress(p.wallet),
    typed_data: p.typedData,
    mac: p.mac,
    signature,
    pop_signature: pop,
  });
  members.setApiKey(userId, api_key.api_key, p.secret, p.publicKey);
  pendingEnrollments.delete(challengeId);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pendingEnrollments) if (now > p.expires) pendingEnrollments.delete(id);
}, 60_000).unref();
