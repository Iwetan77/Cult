import type { WalletSigner } from '../chain/signer.js';
import { PrivyPolicySigner } from '../privy/policy.js';
import { members } from '../store/members.js';

// Which wallet signer the backend uses to act for a member. In production
// that's the member's Privy wallet through the backend's policy-scoped signer,
// so Privy decides what goes through. Test scripts register raw testnet keys.
const overrides = new Map<string, WalletSigner>();

export function registerSigner(userId: string, signer: WalletSigner) {
  overrides.set(userId, signer);
}

export function hasSignerOverride(userId: string) {
  return overrides.has(userId);
}

export function signerFor(userId: string): WalletSigner {
  const o = overrides.get(userId);
  if (o) return o;
  const m = members.get(userId);
  if (!m?.privyWalletId) throw new Error(`member ${userId} has no Privy wallet id; backend signer not granted`);
  return new PrivyPolicySigner(m.privyWalletId, m.wallet);
}
