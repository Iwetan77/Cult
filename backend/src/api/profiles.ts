import { recordsFor, type ClosedTrade, type MemberStats } from '../indexer/stats.js';
import { getDb } from '../store/db.js';
import { clans } from '../store/clans.js';
import { members, type Member } from '../store/members.js';
import { countryName } from './countries.js';
import { shortName } from './names.js';
import { marketSymbol } from './symbols.js';

// Profiles and the home feed (the "Account" and "Home" screens).
// Records are verified by the indexer and count own trades only.

const DAY = 86_400_000;

export class ProfileError extends Error {
  constructor(
    readonly status: 404,
    message: string,
  ) {
    super(message);
  }
}

type Shown = ClosedTrade & { symbol: string };
async function withSymbols(trades: ClosedTrade[]): Promise<Shown[]> {
  return Promise.all(trades.map(async (t) => ({ ...t, symbol: t.symbol ?? (await marketSymbol(t.venue, t.market)) })));
}

// How many people were in on a leader's trade: them, plus every copy and stack of it.
function tradersIn(openTx: string): { tradeId: string | null; count: number } {
  const t = getDb().prepare('SELECT id FROM leader_trades WHERE lower(open_tx) = lower(?)').get(openTx) as { id: string } | undefined;
  if (!t) return { tradeId: null, count: 1 };
  const m = (getDb().prepare(`SELECT count(*) AS n FROM mirrors WHERE trade_id = ? AND status IN ('open', 'closed')`).get(t.id) as { n: number }).n;
  const s = (getDb().prepare(`SELECT count(*) AS n FROM stacks WHERE target_trade = ? AND status = 'open'`).get(t.id) as { n: number }).n;
  return { tradeId: t.id, count: 1 + m + s };
}

function resolve(idOrWallet: string, viewerId: string): Member {
  if (idOrWallet === 'me') return members.get(viewerId)!;
  const m = /^0x[0-9a-fA-F]{40}$/.test(idOrWallet) ? members.byWallet(idOrWallet) : members.get(idOrWallet);
  if (!m) throw new ProfileError(404, 'no such member');
  return m;
}

export interface Profile {
  id: string;
  name: string;
  address: string;
  country: { code: string; name: string | null } | null;
  memberSince: number;
  isMe: boolean;
  record: MemberStats;
  openTrades: { tradeId: string; markerId: string; venue: string; market: string; symbol: string; side: string; leverage: number; openedAt: number }[];
  closedTrades: Shown[]; // newest first, own and copied (flagged), up to 50
  cults: { id: string; name: string; visibility: string }[]; // public ones, plus any shared with the viewer
}

export async function profile(idOrWallet: string, viewerId: string): Promise<Profile> {
  const m = resolve(idOrWallet, viewerId);
  const rec = (await recordsFor([m.wallet])).get(m.wallet.toLowerCase())!;
  const open = getDb()
    .prepare('SELECT id, venue, market, side, leverage, opened_at FROM leader_trades WHERE user_id = ? AND closed_at IS NULL ORDER BY opened_at DESC')
    .all(m.userId) as { id: string; venue: 'perpl' | 'nadfun'; market: string; side: string; leverage: number; opened_at: number }[];
  return {
    id: m.userId,
    name: shortName(m.wallet),
    address: m.wallet,
    country: m.country ? { code: m.country, name: countryName(m.country) } : null,
    memberSince: m.createdAt,
    isMe: m.userId === viewerId,
    record: rec.stats,
    openTrades: await Promise.all(
      open.map(async (t) => ({
        tradeId: t.id,
        markerId: `trade:${t.id}`,
        venue: t.venue,
        market: t.market,
        symbol: await marketSymbol(t.venue, t.market),
        side: t.side,
        leverage: t.leverage / 100,
        openedAt: t.opened_at,
      })),
    ),
    closedTrades: await withSymbols(rec.trades.slice(0, 50)),
    cults: clans
      .forUser(m.userId)
      .filter((c) => c.visibility === 'public' || !!clans.membership(c.id, viewerId))
      .map((c) => ({ id: c.id, name: c.name, visibility: c.visibility })),
  };
}

export interface TopTrade {
  rank: number;
  memberId: string;
  name: string;
  venue: string;
  market: string;
  symbol: string;
  side: string;
  returnPct: number;
  pnlUsd: number | null;
  closedAt: number;
  tradersIn: number; // the caller plus everyone who copied or stacked it
  markerId: string | null;
}

export interface Home {
  topTrades: TopTrade[]; // best own trades closed in the last 7 days, across Cult
  sevenDay: { trades: number; profitUsd: number; positionsOpened: number }; // yours
  asOf: string;
}

export async function home(viewerId: string, limit = 10): Promise<Home> {
  const everyone = members.all();
  const records = await recordsFor(everyone.map((m) => m.wallet));
  const since = Date.now() - 7 * DAY;
  const candidates: (ClosedTrade & { member: Member })[] = [];
  for (const m of everyone) {
    for (const t of records.get(m.wallet.toLowerCase())?.trades ?? []) {
      if (!t.copied && t.closedAt >= since && t.returnPct != null) candidates.push({ ...t, member: m });
    }
  }
  candidates.sort((a, b) => b.returnPct! - a.returnPct!);
  const top = await Promise.all(
    candidates.slice(0, limit).map(async (t, i) => {
      const inOn = tradersIn(t.openTx);
      return {
        rank: i + 1,
        memberId: t.member.userId,
        name: shortName(t.member.wallet),
        venue: t.venue,
        market: t.market,
        symbol: t.symbol ?? (await marketSymbol(t.venue, t.market)),
        side: t.side,
        returnPct: t.returnPct!,
        pnlUsd: t.pnlUsd,
        closedAt: t.closedAt,
        tradersIn: inOn.count,
        markerId: inOn.tradeId ? `trade:${inOn.tradeId}` : null,
      };
    }),
  );
  const me = members.get(viewerId)!;
  const mine = (records.get(me.wallet.toLowerCase())?.trades ?? []).filter((t) => !t.copied && t.closedAt >= since);
  const opened = (getDb().prepare('SELECT count(*) AS n FROM leader_trades WHERE user_id = ? AND opened_at >= ?').get(viewerId, since) as { n: number }).n;
  return {
    topTrades: top,
    sevenDay: { trades: mine.length, profitUsd: mine.reduce((a, t) => a + (t.pnlUsd ?? 0), 0), positionsOpened: opened },
    asOf: new Date().toISOString(),
  };
}
