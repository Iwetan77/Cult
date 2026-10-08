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
  privyPolicyId: string | null;
  country: string | null; // ISO 3166 alpha-2
  username: string | null;
  avatarAt: number | null; // when their photo last changed; null = no photo
  usernameChangedAt: number | null; // last change after the first pick (one per USERNAME_CHANGE_MONTHS)
  createdAt: number; // first sign-in
}

interface Row {
  user_id: string;
  wallet: string;
  privy_wallet_id: string | null;
  perpl_account_id: number | null;
  api_key: string | null;
  api_key_pubkey: string | null;
  forwarding: number;
  privy_policy_id: string | null;
  country: string | null;
  username: string | null;
  avatar_at: number | null;
  username_changed_at?: number | null;
  created_at: number;
}

const toMember = (r: Row): Member => ({
  userId: r.user_id,
  wallet: r.wallet,
  privyWalletId: r.privy_wallet_id,
  perplAccountId: r.perpl_account_id,
  apiKey: r.api_key,
  apiKeyPubkey: r.api_key_pubkey,
  forwarding: r.forwarding === 1,
  privyPolicyId: r.privy_policy_id,
  country: r.country ?? null,
  username: r.username ?? null,
  avatarAt: r.avatar_at ?? null,
  usernameChangedAt: r.username_changed_at ?? null,
  createdAt: r.created_at,
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

  byUsername(username: string): Member | null {
    const r = getDb().prepare('SELECT * FROM members WHERE lower(username) = lower(?)').get(username) as Row | undefined;
    return r ? toMember(r) : null;
  },

  // `changed`: a change after the first pick, which starts the wait for the next one.
  setUsername(userId: string, username: string, changed = false) {
    if (changed) getDb().prepare('UPDATE members SET username = ?, username_changed_at = ? WHERE user_id = ?').run(username, Date.now(), userId);
    else getDb().prepare('UPDATE members SET username = ? WHERE user_id = ?').run(username, userId);
  },

  setAvatar(userId: string, mime: string, bytes: Uint8Array) {
    const now = Date.now();
    const db = getDb();
    db.prepare('INSERT INTO avatars (user_id, mime, bytes, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, updated_at = excluded.updated_at').run(userId, mime, bytes, now);
    db.prepare('UPDATE members SET avatar_at = ? WHERE user_id = ?').run(now, userId);
  },

  clearAvatar(userId: string) {
    getDb().prepare('DELETE FROM avatars WHERE user_id = ?').run(userId);
    getDb().prepare('UPDATE members SET avatar_at = NULL WHERE user_id = ?').run(userId);
  },

  avatar(userId: string): { mime: string; bytes: Uint8Array; updatedAt: number } | null {
    const r = getDb().prepare('SELECT mime, bytes, updated_at FROM avatars WHERE user_id = ?').get(userId) as { mime: string; bytes: Uint8Array; updated_at: number } | undefined;
    return r ? { mime: r.mime, bytes: r.bytes, updatedAt: r.updated_at } : null;
  },

  setCountry(userId: string, country: string) {
    getDb().prepare('UPDATE members SET country = ? WHERE user_id = ?').run(country, userId);
  },

  // Everyone (global) or one country, for leaderboards.
  all(country?: string): Member[] {
    const rows = (country
      ? getDb().prepare('SELECT * FROM members WHERE country = ?').all(country)
      : getDb().prepare('SELECT * FROM members').all()) as unknown as Row[];
    return rows.map(toMember);
  },

  setForwarding(userId: string, on: boolean) {
    getDb().prepare('UPDATE members SET forwarding = ? WHERE user_id = ?').run(on ? 1 : 0, userId);
  },

  setApiKey(userId: string, apiKey: string, secret: Uint8Array, pubkey: string) {
    getDb()
      .prepare('UPDATE members SET api_key = ?, api_key_secret = ?, api_key_pubkey = ? WHERE user_id = ?')
      .run(apiKey, seal(secret), pubkey, userId);
  },

  privyPolicy(userId: string): { id: string; capRaw: bigint; rules: string | null } | null {
    const r = getDb().prepare('SELECT privy_policy_id, privy_policy_cap, privy_policy_rules FROM members WHERE user_id = ?').get(userId) as
      | { privy_policy_id: string | null; privy_policy_cap: number | null; privy_policy_rules: string | null }
      | undefined;
    return r?.privy_policy_id ? { id: r.privy_policy_id, capRaw: BigInt(r.privy_policy_cap ?? 0), rules: r.privy_policy_rules } : null;
  },

  setPrivyPolicy(userId: string, id: string, capRaw: bigint, rules: string) {
    getDb()
      .prepare('UPDATE members SET privy_policy_id = ?, privy_policy_cap = ?, privy_policy_rules = ? WHERE user_id = ?')
      .run(id, Number(capRaw), rules, userId);
  },

  credentials(userId: string): ApiKeyCredentials | null {
    const r = getDb().prepare('SELECT api_key, api_key_secret FROM members WHERE user_id = ?').get(userId) as
      | { api_key: string | null; api_key_secret: string | null }
      | undefined;
    if (!r?.api_key || !r.api_key_secret) return null;
    return { apiKey: r.api_key, secret: unseal(r.api_key_secret) };
  },
};
