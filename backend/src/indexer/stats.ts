import pg from 'pg';
import { monPriceAusd } from '../prices.js';
import { getDb } from '../store/db.js';

// Verified track record from the indexer (Envio HyperIndex). See indexer/API.md
// on the indexer branch. Two ways to reach it:
//   INDEXER_GRAPHQL_URL  its GraphQL (Hasura, e.g. Envio Cloud)
//   INDEXER_PG_URL       its Postgres directly (self-hosted without Hasura or
//                        Docker: envio start with ENVIO_HASURA=false). Use a
//                        read-only user. INDEXER_PG_SCHEMA if not "public".
// GraphQL wins if both are set. The indexer keeps Perpl PnL in AUSD and
// Nad.fun PnL in MON and never adds them; the backend serves the combined
// dollar figure and says which MON price it used.

// A member's record counts **their own trades only** (product decision,
// 2026-09-27). Round trips the engine opened for them (auto-mirrors, manual
// stacks) are left out and reported apart under `copied`, so a follower's
// record isn't their leader's calls. The indexer reads the chain; which txs
// were ours comes from the backend's own log of what it sent.

export interface MemberStats {
  verified: boolean; // the indexer has this wallet's on-chain history
  tradeCount: number; // own closed round trips
  winRate: number | null; // 0..1 over own trades, null with none closed
  realizedPnlPerplUsd: number; // own, AUSD
  realizedPnlMon: number; // own, MON
  realizedPnlUsd: number | null; // own, perpl + nad.fun converted at monPriceUsed; null if no MON price
  monPriceUsed: number | null;
  lastTradeAt: number | null; // own
  streak: number; // own wins in a row, counting back from the latest own close
  avgWinPct: number | null; // mean return % of own winning trades
  recent: { d7: RecentWindow; d30: RecentWindow }; // own trades closed in the last 7 / 30 days
  copied: { tradeCount: number; winRate: number | null; realizedPnlUsd: number | null }; // mirrors + stacks
}

export interface RecentWindow {
  tradeCount: number;
  winRate: number | null;
  realizedPnlUsd: number | null; // null if any Nad.fun trade in it has no MON price
}

// One closed round trip, either venue, normalised for profiles and the home feed.
export interface ClosedTrade {
  venue: 'perpl' | 'nadfun';
  market: string; // perpl market id | token address
  symbol: string | null; // perpl symbol; tokens are looked up by the caller
  side: string; // long | short | buy
  returnPct: number | null; // perpl: price move in the trade's direction; nad.fun: proceeds / cost - 1
  pnlUsd: number | null; // nad.fun converted at the MON price used
  entryPrice: number | null; // perpl only ($ per unit, size-weighted over adds)
  exitPrice: number | null; // perpl only
  isWin: boolean;
  openedAt: number | null;
  closedAt: number;
  openTx: string;
  copied: boolean; // Cult opened it for them (auto-mirror or stack)
}

export interface MemberRecord {
  stats: MemberStats;
  trades: ClosedTrade[]; // newest first, own and copied
}

const UNVERIFIED: MemberStats = {
  verified: false,
  tradeCount: 0,
  winRate: null,
  realizedPnlPerplUsd: 0,
  realizedPnlMon: 0,
  realizedPnlUsd: null,
  monPriceUsed: null,
  lastTradeAt: null,
  streak: 0,
  avgWinPct: null,
  recent: { d7: { tradeCount: 0, winRate: null, realizedPnlUsd: null }, d30: { tradeCount: 0, winRate: null, realizedPnlUsd: null } },
  copied: { tradeCount: 0, winRate: null, realizedPnlUsd: null },
};

const QUERY = `query CultMemberStats($ids: [String!]!) {
  Trader(where: { id: { _in: $ids } }) {
    id
    trades { openTx realizedPnlUsd isWin closedAt openedAt marketId symbol side entryPrice exitPrice }
    nadFunTrades { openTx realizedPnlMon isWin closedAt openedAt token costMon proceedsMon }
  }
}`;

type Num = number | string;
export interface TraderRow {
  id: string;
  trades: { openTx: string; realizedPnlUsd: Num; isWin: boolean; closedAt: Num; openedAt?: Num; marketId?: Num; symbol?: string; side?: string; entryPrice?: Num; exitPrice?: Num }[];
  nadFunTrades: { openTx: string; realizedPnlMon: Num; isWin: boolean; closedAt: Num; openedAt?: Num; token?: string; costMon?: Num; proceedsMon?: Num }[];
}

const num = (x: Num | undefined | null) => (x == null || x === '' ? null : Number(x));

export function closedTrades(row: TraderRow, monPx: number | null, sentByUs: Set<string>): ClosedTrade[] {
  const out: ClosedTrade[] = [];
  for (const t of row.trades ?? []) {
    const [entry, exit] = [num(t.entryPrice), num(t.exitPrice)];
    const short = /short/i.test(t.side ?? '');
    out.push({
      venue: 'perpl',
      market: String(t.marketId ?? ''),
      symbol: t.symbol ?? null,
      side: short ? 'short' : 'long',
      returnPct: entry && exit != null ? ((exit - entry) / entry) * 100 * (short ? -1 : 1) : null,
      pnlUsd: Number(t.realizedPnlUsd),
      entryPrice: entry,
      exitPrice: exit,
      isWin: t.isWin,
      openedAt: num(t.openedAt),
      closedAt: Number(t.closedAt),
      openTx: t.openTx,
      copied: sentByUs.has(t.openTx.toLowerCase()),
    });
  }
  for (const t of row.nadFunTrades ?? []) {
    const [cost, proceeds] = [num(t.costMon), num(t.proceedsMon)];
    out.push({
      venue: 'nadfun',
      market: (t.token ?? '').toLowerCase(),
      symbol: null,
      side: 'buy',
      returnPct: cost && proceeds != null ? (proceeds / cost - 1) * 100 : null,
      pnlUsd: monPx != null ? Number(t.realizedPnlMon) * monPx : null,
      entryPrice: null,
      exitPrice: null,
      isWin: t.isWin,
      openedAt: num(t.openedAt),
      closedAt: Number(t.closedAt),
      openTx: t.openTx,
      copied: sentByUs.has(t.openTx.toLowerCase()),
    });
  }
  return out.sort((a, b) => b.closedAt - a.closedAt);
}

// Own vs copied, split by the tx that opened each round trip.
export function toStats(row: TraderRow | undefined, monPx: number | null, sentByUs: Set<string>): MemberStats {
  if (!row) return UNVERIFIED;
  const acc = () => ({ n: 0, wins: 0, usd: 0, mon: 0, last: null as number | null });
  const own = acc();
  const copied = acc();
  const add = (a: ReturnType<typeof acc>, win: boolean, closedAt: Num, usd: number, mon: number) => {
    a.n++;
    if (win) a.wins++;
    a.usd += usd;
    a.mon += mon;
    a.last = Math.max(a.last ?? 0, Number(closedAt));
  };
  for (const t of row.trades ?? []) add(sentByUs.has(t.openTx.toLowerCase()) ? copied : own, t.isWin, t.closedAt, Number(t.realizedPnlUsd), 0);
  for (const t of row.nadFunTrades ?? []) add(sentByUs.has(t.openTx.toLowerCase()) ? copied : own, t.isWin, t.closedAt, 0, Number(t.realizedPnlMon));
  const inUsd = (a: ReturnType<typeof acc>) => (monPx != null ? a.usd + a.mon * monPx : a.mon === 0 ? a.usd : null);
  const mine = closedTrades(row, monPx, sentByUs).filter((t) => !t.copied);
  let streak = 0;
  for (const t of mine) {
    if (!t.isWin) break;
    streak++;
  }
  const winPcts = mine.filter((t) => t.isWin && t.returnPct != null).map((t) => t.returnPct!);
  const window = (days: number): RecentWindow => {
    const since = Date.now() - days * 86_400_000;
    const w = mine.filter((t) => t.closedAt >= since);
    const wins = w.filter((t) => t.isWin).length;
    return {
      tradeCount: w.length,
      winRate: w.length ? wins / w.length : null,
      realizedPnlUsd: w.some((t) => t.pnlUsd == null) ? null : w.reduce((a, t) => a + t.pnlUsd!, 0),
    };
  };
  return {
    verified: true,
    tradeCount: own.n,
    winRate: own.n > 0 ? own.wins / own.n : null,
    realizedPnlPerplUsd: own.usd,
    realizedPnlMon: own.mon,
    realizedPnlUsd: inUsd(own),
    monPriceUsed: monPx,
    lastTradeAt: own.last,
    streak,
    avgWinPct: winPcts.length ? winPcts.reduce((a, b) => a + b, 0) / winPcts.length : null,
    recent: { d7: window(7), d30: window(30) },
    copied: { tradeCount: copied.n, winRate: copied.n > 0 ? copied.wins / copied.n : null, realizedPnlUsd: inUsd(copied) },
  };
}

// Every tx the engine sent for these wallets: auto-mirror and stack opens,
// adds, partial sells and exits (Nad.fun hashes), plus Perpl mirror/stack
// order txs. A round trip whose opening tx is in here was copied, not called.
function sentByUsFor(wallets: string[]): Set<string> {
  const db = getDb();
  const out = new Set<string>();
  const marks = wallets.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT tx_hash AS h FROM engine_txs WHERE wallet IN (${marks})`).all(...wallets) as { h: string }[]) out.add(r.h.toLowerCase());
  const byUser = `SELECT user_id FROM members WHERE wallet IN (${marks})`;
  for (const t of ['mirrors', 'stacks']) {
    for (const r of db.prepare(`SELECT open_tx AS h FROM ${t} WHERE open_tx IS NOT NULL AND user_id IN (${byUser})`).all(...wallets) as { h: string }[]) out.add(r.h.toLowerCase());
  }
  return out;
}

let pool: pg.Pool | undefined;
function pgPool(url: string) {
  pool ??= new pg.Pool({ connectionString: url, max: 3, statement_timeout: 5_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', (e) => console.warn('[indexer] postgres:', e.message));
  return pool;
}

async function viaGraphql(url: string, ids: string[]): Promise<TraderRow[]> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.INDEXER_GRAPHQL_SECRET) headers['x-hasura-admin-secret'] = process.env.INDEXER_GRAPHQL_SECRET;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query: QUERY, variables: { ids } }), signal: AbortSignal.timeout(5_000) });
  const body = (await r.json()) as { data?: { Trader?: TraderRow[] }; errors?: { message: string }[] };
  if (!r.ok || body.errors?.length || !body.data?.Trader) throw new Error(body.errors?.[0]?.message ?? `HTTP ${r.status}`);
  return body.data.Trader;
}

// The same shape as the GraphQL query, from Envio's own tables.
async function viaPostgres(url: string, ids: string[]): Promise<TraderRow[]> {
  const schema = (process.env.INDEXER_PG_SCHEMA || 'public').replace(/"/g, '');
  const q = (sql: string) => pgPool(url).query(sql, [ids]).then((r) => r.rows as Record<string, unknown>[]);
  const [traders, perpl, nad] = await Promise.all([
    q(`SELECT id FROM "${schema}"."Trader" WHERE id = ANY($1)`),
    q(`SELECT trader_id, "openTx", "realizedPnlUsd", "isWin", "closedAt", "openedAt", "marketId", symbol, side, "entryPrice", "exitPrice" FROM "${schema}"."Trade" WHERE trader_id = ANY($1)`),
    q(`SELECT trader_id, "openTx", "realizedPnlMon", "isWin", "closedAt", "openedAt", token, "costMon", "proceedsMon" FROM "${schema}"."NadFunTrade" WHERE trader_id = ANY($1)`),
  ]);
  const rows = new Map<string, TraderRow>(traders.map((t) => [String(t.id), { id: String(t.id), trades: [], nadFunTrades: [] }]));
  for (const t of perpl) rows.get(String(t.trader_id))?.trades.push(t as never);
  for (const t of nad) rows.get(String(t.trader_id))?.nadFunTrades.push(t as never);
  return [...rows.values()];
}

const cache = new Map<string, { at: number; record: MemberRecord }>();
const TTL_MS = 15_000;
const UNVERIFIED_RECORD: MemberRecord = { stats: UNVERIFIED, trades: [] };

// Records (stats + closed trades) for many wallets in one indexer round trip.
// Never throws: an unconfigured or unreachable indexer means "unverified".
export async function recordsFor(wallets: string[]): Promise<Map<string, MemberRecord>> {
  const out = new Map<string, MemberRecord>();
  const ids = [...new Set(wallets.map((w) => w.toLowerCase()))];
  const gqlUrl = process.env.INDEXER_GRAPHQL_URL;
  const pgUrl = process.env.INDEXER_PG_URL;
  const fresh = ids.filter((id) => {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) {
      out.set(id, hit.record);
      return false;
    }
    return true;
  });
  if ((!gqlUrl && !pgUrl) || fresh.length === 0) {
    for (const id of fresh) out.set(id, UNVERIFIED_RECORD);
    return out;
  }
  try {
    const found = gqlUrl ? await viaGraphql(gqlUrl, fresh) : await viaPostgres(pgUrl!, fresh);
    const monPx = await monPriceAusd().catch(() => null);
    const rows = new Map(found.map((t) => [t.id.toLowerCase(), t]));
    const ours = sentByUsFor(fresh);
    for (const id of fresh) {
      const row = rows.get(id);
      const record = row ? { stats: toStats(row, monPx, ours), trades: closedTrades(row, monPx, ours) } : UNVERIFIED_RECORD;
      cache.set(id, { at: Date.now(), record });
      out.set(id, record);
    }
  } catch (e) {
    console.warn('[indexer] stats unavailable:', (e as Error).message);
    for (const id of fresh) out.set(id, UNVERIFIED_RECORD);
  }
  return out;
}

export async function statsFor(wallets: string[]): Promise<Map<string, MemberStats>> {
  const out = new Map<string, MemberStats>();
  for (const [k, v] of await recordsFor(wallets)) out.set(k, v.stats);
  return out;
}
