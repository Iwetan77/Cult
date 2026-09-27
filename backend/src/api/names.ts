import { members, type Member } from '../store/members.js';

export const shortName = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

// What people see for a member: their username, else their short wallet.
export function displayName(m: Member | null | undefined, fallback = 'someone'): string {
  if (!m) return fallback;
  return m.username ?? shortName(m.wallet);
}

export const nameOf = (userId: string) => displayName(members.get(userId), shortName(userId));

// Their photo, as a path on this API (prefix it with the API base URL), or null.
// The ?v= changes with every upload, so it can be cached for a long time.
export function avatarUrl(m: Member | null | undefined): string | null {
  return m?.avatarAt ? `/v1/avatars/${encodeURIComponent(m.userId)}?v=${m.avatarAt}` : null;
}

export const avatarOf = (userId: string) => avatarUrl(members.get(userId));

// Usernames: 3-20 letters, digits or underscores, starting with a letter;
// unique ignoring case. A few words are kept for the app itself.
const RESERVED = new Set(['admin', 'administrator', 'cult', 'cults', 'support', 'global', 'system', 'root', 'moderator', 'mod', 'staff', 'team', 'help', 'me', 'official']);
export function usernameProblem(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(name)) return 'use 3-20 letters, numbers or _ , starting with a letter';
  if (RESERVED.has(name.toLowerCase())) return 'that name is reserved';
  return null;
}
