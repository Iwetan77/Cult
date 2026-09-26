import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db.js';

// MirrorPolicy, as the frontend sends it at clan-join (frontend/src/lib/contracts.ts).
// Units and bounds are defined here and published in CONTRACTS.md.
export const MirrorPolicySchema = z.object({
  enabled: z.boolean(),
  balancePercentCap: z.number().gt(0).max(100), // % of free Perpl balance one mirror may use as margin
  maxUsdPerTrade: z.number().min(1).max(1_000_000), // max notional of one mirrored position, USD
});
export type MirrorPolicy = z.infer<typeof MirrorPolicySchema>;

export interface Clan {
  id: string;
  name: string;
  inviteCode: string;
  createdBy: string;
  createdAt: number;
}

export interface ClanMembership {
  clanId: string;
  userId: string;
  policy: MirrorPolicy;
  joinedAt: number;
}

interface ClanRow {
  id: string;
  name: string;
  invite_code: string;
  created_by: string;
  created_at: number;
}
interface MemberRow {
  clan_id: string;
  user_id: string;
  mirror_enabled: number;
  balance_percent_cap: number;
  max_usd_per_trade: number;
  joined_at: number;
}

const toClan = (r: ClanRow): Clan => ({
  id: r.id,
  name: r.name,
  inviteCode: r.invite_code,
  createdBy: r.created_by,
  createdAt: r.created_at,
});
const toMembership = (r: MemberRow): ClanMembership => ({
  clanId: r.clan_id,
  userId: r.user_id,
  policy: { enabled: r.mirror_enabled === 1, balancePercentCap: r.balance_percent_cap, maxUsdPerTrade: r.max_usd_per_trade },
  joinedAt: r.joined_at,
});

export const clans = {
  create(name: string, createdBy: string, creatorPolicy: MirrorPolicy): Clan {
    const id = randomUUID();
    const inviteCode = randomBytes(6).toString('base64url');
    const db = getDb();
    db.prepare('INSERT INTO clans (id, name, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      name,
      inviteCode,
      createdBy,
      Date.now(),
    );
    this.join(id, createdBy, creatorPolicy);
    return this.get(id)!;
  },

  get(id: string): Clan | null {
    const r = getDb().prepare('SELECT * FROM clans WHERE id = ?').get(id) as ClanRow | undefined;
    return r ? toClan(r) : null;
  },

  byInvite(code: string): Clan | null {
    const r = getDb().prepare('SELECT * FROM clans WHERE invite_code = ?').get(code) as ClanRow | undefined;
    return r ? toClan(r) : null;
  },

  // Policy is written once here. There's deliberately no per-trade prompt.
  join(clanId: string, userId: string, policy: MirrorPolicy) {
    const p = MirrorPolicySchema.parse(policy);
    getDb()
      .prepare(
        `INSERT INTO clan_members (clan_id, user_id, mirror_enabled, balance_percent_cap, max_usd_per_trade, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(clan_id, user_id) DO NOTHING`,
      )
      .run(clanId, userId, p.enabled ? 1 : 0, p.balancePercentCap, p.maxUsdPerTrade, Date.now());
  },

  members(clanId: string): ClanMembership[] {
    return (getDb().prepare('SELECT * FROM clan_members WHERE clan_id = ? ORDER BY joined_at').all(clanId) as unknown as MemberRow[]).map(
      toMembership,
    );
  },

  membership(clanId: string, userId: string): ClanMembership | null {
    const r = getDb().prepare('SELECT * FROM clan_members WHERE clan_id = ? AND user_id = ?').get(clanId, userId) as
      | MemberRow
      | undefined;
    return r ? toMembership(r) : null;
  },

  forUser(userId: string): Clan[] {
    return (
      getDb()
        .prepare('SELECT c.* FROM clans c JOIN clan_members m ON m.clan_id = c.id WHERE m.user_id = ? ORDER BY c.created_at')
        .all(userId) as unknown as ClanRow[]
    ).map(toClan);
  },

  allMemberUserIds(): string[] {
    return (getDb().prepare('SELECT DISTINCT user_id FROM clan_members').all() as { user_id: string }[]).map((r) => r.user_id);
  },
};
