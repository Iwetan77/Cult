import { randomInt, randomUUID } from 'node:crypto';
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

// Joining a cult is just joining the group: copying stays off until the member
// turns Auto-follow on (and signs their limits). These are the limits the
// Auto-follow switch suggests.
export const AUTO_FOLLOW_DEFAULTS = { balancePercentCap: 10, maxUsdPerTrade: 100 } as const;
export const COPY_OFF: MirrorPolicy = { enabled: false, ...AUTO_FOLLOW_DEFAULTS };

// A cult (the product's name for a clan; the code and API keep "clan" in
// identifiers so nothing breaks). Private cults are joined with their code;
// public ones are listed and anyone can join (still with signed consent).
export type Visibility = 'private' | 'public';

export interface Clan {
  id: string;
  name: string;
  inviteCode: string;
  createdBy: string;
  createdAt: number;
  visibility: Visibility;
}

// Invite codes: six letters shown as ABC-DEF. 26^6 ~ 309M, so guessing one is hopeless.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function newInviteCode(): string {
  const l = () => LETTERS[randomInt(26)];
  return `${l()}${l()}${l()}-${l()}${l()}${l()}`;
}
// What people type: any case, with or without the dash or spaces.
export function normalizeInviteCode(input: string): string {
  if (!/^[A-Za-z\s-]+$/.test(input)) return input.trim(); // legacy codes carry digits/underscores
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
  return letters.length === 6 ? `${letters.slice(0, 3)}-${letters.slice(3)}` : input.trim();
}

export type CultRole = 'admin' | 'member';

export interface ClanMembership {
  clanId: string;
  userId: string;
  policy: MirrorPolicy;
  joinedAt: number;
  role: CultRole; // admins share trades with the cult; the creator is always one
}

interface ClanRow {
  id: string;
  name: string;
  invite_code: string;
  created_by: string;
  created_at: number;
  visibility: Visibility;
}
interface MemberRow {
  clan_id: string;
  user_id: string;
  mirror_enabled: number;
  balance_percent_cap: number;
  max_usd_per_trade: number;
  joined_at: number;
  role: string | null;
}

const toClan = (r: ClanRow): Clan => ({
  id: r.id,
  name: r.name,
  inviteCode: r.invite_code,
  createdBy: r.created_by,
  createdAt: r.created_at,
  visibility: r.visibility === 'public' ? 'public' : 'private',
});
const toMembership = (r: MemberRow): ClanMembership => ({
  clanId: r.clan_id,
  userId: r.user_id,
  policy: { enabled: r.mirror_enabled === 1, balancePercentCap: r.balance_percent_cap, maxUsdPerTrade: r.max_usd_per_trade },
  joinedAt: r.joined_at,
  role: r.role === 'admin' ? 'admin' : 'member',
});

export const clans = {
  create(name: string, createdBy: string, creatorPolicy: MirrorPolicy = COPY_OFF, visibility: Visibility = 'private'): Clan {
    const id = randomUUID();
    const db = getDb();
    for (let attempt = 0; ; attempt++) {
      try {
        db.prepare('INSERT INTO clans (id, name, invite_code, created_by, created_at, visibility) VALUES (?, ?, ?, ?, ?, ?)').run(
          id,
          name,
          newInviteCode(),
          createdBy,
          Date.now(),
          visibility,
        );
        break;
      } catch (e) {
        if (attempt < 5 && /UNIQUE/.test(String(e))) continue; // code taken: draw another
        throw e;
      }
    }
    this.join(id, createdBy, creatorPolicy);
    this.setRole(id, createdBy, 'admin');
    return this.get(id)!;
  },

  // Admins share their trades with the cult (chart, chat, copies) and can make
  // other members admins. The creator always is one.
  isAdmin(clanId: string, userId: string): boolean {
    const c = this.get(clanId);
    if (!c) return false;
    return c.createdBy === userId || this.membership(clanId, userId)?.role === 'admin';
  },

  setRole(clanId: string, userId: string, role: CultRole) {
    getDb().prepare('UPDATE clan_members SET role = ? WHERE clan_id = ? AND user_id = ?').run(role, clanId, userId);
  },

  // The cults this member shares trades with (the ones they're an admin of).
  adminCultIds(userId: string): string[] {
    return this.forUser(userId).filter((c) => this.isAdmin(c.id, userId)).map((c) => c.id);
  },

  setVisibility(id: string, visibility: Visibility) {
    getDb().prepare('UPDATE clans SET visibility = ? WHERE id = ?').run(visibility, id);
  },

  // Public cults, newest first (callers rank them).
  publicList(limit = 200): Clan[] {
    return (getDb().prepare(`SELECT * FROM clans WHERE visibility = 'public' ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as ClanRow[]).map(toClan);
  },

  get(id: string): Clan | null {
    const r = getDb().prepare('SELECT * FROM clans WHERE id = ?').get(id) as ClanRow | undefined;
    return r ? toClan(r) : null;
  },

  byInvite(code: string): Clan | null {
    const db = getDb();
    const r = (db.prepare('SELECT * FROM clans WHERE invite_code = ?').get(normalizeInviteCode(code)) ??
      db.prepare('SELECT * FROM clans WHERE invite_code = ?').get(code.trim())) as ClanRow | undefined; // legacy codes
    return r ? toClan(r) : null;
  },

  // Policy is written once here. There's deliberately no per-trade prompt.
  join(clanId: string, userId: string, policy: MirrorPolicy = COPY_OFF) {
    const p = MirrorPolicySchema.parse(policy);
    getDb()
      .prepare(
        `INSERT INTO clan_members (clan_id, user_id, mirror_enabled, balance_percent_cap, max_usd_per_trade, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(clan_id, user_id) DO NOTHING`,
      )
      .run(clanId, userId, p.enabled ? 1 : 0, p.balancePercentCap, p.maxUsdPerTrade, Date.now());
  },

  // Replaces the member's policy (after they've signed a fresh consent).
  setPolicy(clanId: string, userId: string, policy: MirrorPolicy) {
    const p = MirrorPolicySchema.parse(policy);
    getDb()
      .prepare('UPDATE clan_members SET mirror_enabled = ?, balance_percent_cap = ?, max_usd_per_trade = ? WHERE clan_id = ? AND user_id = ?')
      .run(p.enabled ? 1 : 0, p.balancePercentCap, p.maxUsdPerTrade, clanId, userId);
  },

  leave(clanId: string, userId: string) {
    getDb().prepare('DELETE FROM clan_members WHERE clan_id = ? AND user_id = ?').run(clanId, userId);
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
