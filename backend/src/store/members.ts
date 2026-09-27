import type { ApiKeyCredentials } from '../perpl/auth.js';
import { getDb } from './db.js';
import { seal, unseal } from './crypto.js';

export interface Member {
  userId: string;
  wallet: string;
  privyWalletId: string | null;
  perplAccountId: number | null;
  apiKey: string | null;
  apiKeyPubkey: string | null;
  forwarding: boolean;
}

interface Row {
  user_id: string;
  wallet: string;
  privy_wallet_id: string | null;
  perpl_account_id: number | null;
  api_key: string | null;
  api_key_pubkey: string | null;
  forwarding: number;
}

const toMember = (r: Row): Member => ({
  userId: r.user_id,
  wallet: r.wallet,
  privyWalletId: r.privy_wallet_id,
  perplAccountId: r.perpl_account_id,
  apiKey: r.api_key,
  apiKeyPubkey: r.api_key_pubkey,
  forwarding: r.forwarding === 1,
});

export const members = {
  upsert(userId: string, wallet: string, privyWalletId: string | null = null): Member {
    getDb()
      .prepare(
        `INSERT INTO members (user_id, wallet, privy_wallet_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET wallet = excluded.wallet,
           privy_wallet_id = COALESCE(excluded.privy_wallet_id, members.privy_wallet_id)`,
      )
      .run(userId, wallet.toLowerCase(), privyWalletId, Date.now());
    return this.get(userId)!;
  },

  get(userId: string): Member | null {
    const r = getDb().prepare('SELECT * FROM members WHERE user_id = ?').get(userId) as Row | undefined;
    return r ? toMember(r) : null;
  },

  byWallet(wallet: string): Member | null {
    const r = getDb().prepare('SELECT * FROM members WHERE wallet = ?').get(wallet.toLowerCase()) as Row | undefined;
    return r ? toMember(r) : null;
  },

  byAccountId(accountId: number): Member | null {
    const r = getDb().prepare('SELECT * FROM members WHERE perpl_account_id = ?').get(accountId) as Row | undefined;
    return r ? toMember(r) : null;
  },

  setAccount(userId: string, accountId: number) {
    getDb().prepare('UPDATE members SET perpl_account_id = ? WHERE user_id = ?').run(accountId, userId);
  },

  setForwarding(userId: string, on: boolean) {
    getDb().prepare('UPDATE members SET forwarding = ? WHERE user_id = ?').run(on ? 1 : 0, userId);
  },

  setApiKey(userId: string, apiKey: string, secret: Uint8Array, pubkey: string) {
    getDb()
      .prepare('UPDATE members SET api_key = ?, api_key_secret = ?, api_key_pubkey = ? WHERE user_id = ?')
      .run(apiKey, seal(secret), pubkey, userId);
  },

  privyPolicy(userId: string): { id: string; capRaw: bigint } | null {
    const r = getDb().prepare('SELECT privy_policy_id, privy_policy_cap FROM members WHERE user_id = ?').get(userId) as
      | { privy_policy_id: string | null; privy_policy_cap: number | null }
      | undefined;
    return r?.privy_policy_id ? { id: r.privy_policy_id, capRaw: BigInt(r.privy_policy_cap ?? 0) } : null;
  },

  setPrivyPolicy(userId: string, id: string, capRaw: bigint) {
    getDb().prepare('UPDATE members SET privy_policy_id = ?, privy_policy_cap = ? WHERE user_id = ?').run(id, Number(capRaw), userId);
  },

  credentials(userId: string): ApiKeyCredentials | null {
    const r = getDb().prepare('SELECT api_key, api_key_secret FROM members WHERE user_id = ?').get(userId) as
      | { api_key: string | null; api_key_secret: string | null }
      | undefined;
    if (!r?.api_key || !r.api_key_secret) return null;
    return { apiKey: r.api_key, secret: unseal(r.api_key_secret) };
  },
};
