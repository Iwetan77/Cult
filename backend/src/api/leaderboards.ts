import { statsFor, type MemberStats } from '../indexer/stats.js';
import { clans, type Clan } from '../store/clans.js';
import { members, type Member } from '../store/members.js';
import { countryName } from './countries.js';
import { shortName } from './names.js';

// Leaderboards, fantasy-league style: everyone is on Global, everyone who
// picked a country is on that country's board, and each cult has its own.
// Ranked by verified realized PnL in $ on the member's OWN trades (copies
// don't count; see indexer/stats.ts), then win rate, then trade count. Only
// members with at least one verified closed trade get a rank.

export interface LeaderboardEntry {
  rank: number;
  memberId: string;
  name: string;
  address: string;
  country: string | null;
  realizedPnlUsd: number;
  winRate: number | null;
  tradeCount: number;
  copiedTradeCount: number;
}

export type Period = 'all' | '30d' | '7d';

export interface Leaderboard {
  scope: string; // global | country:NG | cult:<id>
  name: string;
  metric: 'realizedPnlUsd';
  period: Period;
  entries: LeaderboardEntry[];
  me: (Omit<LeaderboardEntry, 'rank'> & { rank: number | null }) | null; // rank null = no verified closed trade yet
  rankedCount: number;
  memberCount: number;
  asOf: string;
}

const CHUNK = 200;
async function statsForAll(wallets: string[]): Promise<Map<string, MemberStats>> {
  const out = new Map<string, MemberStats>();
  for (let i = 0; i < wallets.length; i += CHUNK) {
    for (const [k, v] of await statsFor(wallets.slice(i, i + CHUNK))) out.set(k, v);
  }
  return out;
}

// The numbers a board ranks on, for the chosen period.
function figures(s: MemberStats | undefined, period: Period) {
  if (!s) return { realizedPnlUsd: null, winRate: null, tradeCount: 0 };
  if (period === 'all') return { realizedPnlUsd: s.realizedPnlUsd, winRate: s.winRate, tradeCount: s.tradeCount };
  return s.recent[period === '7d' ? 'd7' : 'd30'];
}

const ranked = (s: MemberStats | undefined, period: Period) => {
  const f = figures(s, period);
  return !!s && s.verified && f.tradeCount > 0 && f.realizedPnlUsd != null;
};

function byPerformance(a: MemberStats, b: MemberStats, period: Period) {
  const [x, y] = [figures(a, period), figures(b, period)];
  return y.realizedPnlUsd! - x.realizedPnlUsd! || (y.winRate ?? 0) - (x.winRate ?? 0) || y.tradeCount - x.tradeCount;
}

function row(m: Member, s: MemberStats | undefined, period: Period) {
  const f = figures(s, period);
  return {
    memberId: m.userId,
    name: shortName(m.wallet),
    address: m.wallet,
    country: m.country,
    realizedPnlUsd: f.realizedPnlUsd ?? 0,
    winRate: f.winRate ?? null,
    tradeCount: f.tradeCount,
    copiedTradeCount: s?.copied.tradeCount ?? 0,
  };
}

async function build(scope: string, name: string, people: Member[], viewerId: string, limit: number, period: Period = 'all'): Promise<Leaderboard> {
  const stats = await statsForAll(people.map((m) => m.wallet));
  const board = people
    .filter((m) => ranked(stats.get(m.wallet.toLowerCase()), period))
    .sort((a, b) => byPerformance(stats.get(a.wallet.toLowerCase())!, stats.get(b.wallet.toLowerCase())!, period))
    .map((m, i) => ({ rank: i + 1, ...row(m, stats.get(m.wallet.toLowerCase()), period) }));
  const viewer = people.find((m) => m.userId === viewerId);
  const mine = board.find((e) => e.memberId === viewerId);
  return {
    scope,
    name,
    metric: 'realizedPnlUsd',
    period,
    entries: board.slice(0, limit),
    me: mine ?? (viewer ? { rank: null, ...row(viewer, stats.get(viewer.wallet.toLowerCase()), period) } : null),
    rankedCount: board.length,
    memberCount: people.length,
    asOf: new Date().toISOString(),
  };
}

export class LeaderboardError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export function globalBoard(viewerId: string, limit = 100, period: Period = 'all') {
  return build('global', 'Global', members.all(), viewerId, limit, period);
}

export async function countryBoard(code: string, viewerId: string, limit = 100, period: Period = 'all') {
  const cc = code.toUpperCase();
  const name = countryName(cc);
  if (!name) throw new LeaderboardError(400, `${code} isn't a country code`);
  return build(`country:${cc}`, name, members.all(cc), viewerId, limit, period);
}

export function cultBoard(clan: Clan, viewerId: string, limit = 100, period: Period = 'all') {
  const people = clans.members(clan.id).map((m) => members.get(m.userId)!).filter(Boolean);
  return build(`cult:${clan.id}`, clan.name, people, viewerId, limit, period);
}

export function parsePeriod(v: string | undefined): Period {
  if (v === undefined || v === '' || v === 'all') return 'all';
  if (v === '7d' || v === '30d') return v;
  throw new LeaderboardError(400, 'period is all, 30d or 7d');
}

// Public cults against each other: the sum of their members' own verified
// PnL, with a trade-weighted win rate. Private cults never appear.
export interface CultStanding {
  rank: number;
  cultId: string;
  name: string;
  memberCount: number;
  realizedPnlUsd: number;
  winRate: number | null;
  tradeCount: number;
  joined: boolean;
}

export async function cultsBoard(viewerId: string, limit = 50): Promise<{ entries: CultStanding[]; asOf: string }> {
  const list = clans.publicList(500);
  const roster = new Map(list.map((c) => [c.id, clans.members(c.id).map((m) => members.get(m.userId)!).filter(Boolean)]));
  const stats = await statsForAll([...new Set([...roster.values()].flat().map((m) => m.wallet))]);
  const standings = list.map((c) => {
    let pnl = 0;
    let trades = 0;
    let wins = 0;
    for (const m of roster.get(c.id)!) {
      const s = stats.get(m.wallet.toLowerCase());
      if (!ranked(s, 'all')) continue;
      pnl += s!.realizedPnlUsd!;
      trades += s!.tradeCount;
      wins += (s!.winRate ?? 0) * s!.tradeCount;
    }
    return {
      cultId: c.id,
      name: c.name,
      memberCount: roster.get(c.id)!.length,
      realizedPnlUsd: pnl,
      winRate: trades > 0 ? wins / trades : null,
      tradeCount: trades,
      joined: !!clans.membership(c.id, viewerId),
      createdAt: c.createdAt,
    };
  });
  standings.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd || b.tradeCount - a.tradeCount || b.memberCount - a.memberCount || b.createdAt - a.createdAt);
  return {
    entries: standings.slice(0, limit).map(({ createdAt: _c, ...s }, i) => ({ rank: i + 1, ...s })),
    asOf: new Date().toISOString(),
  };
}
