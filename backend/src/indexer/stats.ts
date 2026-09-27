import { monPriceAusd } from '../prices.js';

// Verified track record from the indexer (Envio HyperIndex, GraphQL/Hasura).
// See indexer/API.md on the indexer branch. The indexer keeps Perpl PnL in
// AUSD and Nad.fun PnL in MON and never adds them; the backend serves the
// combined dollar figure and says which MON price it used.

export interface MemberStats {
  verified: boolean; // the indexer has this wallet's on-chain history
  tradeCount: number;
  winRate: number | null; // 0..1, null with no closed trades
  realizedPnlPerplUsd: number; // AUSD
  realizedPnlMon: number; // MON
  realizedPnlUsd: number | null; // perpl + nad.fun converted at monPriceUsed; null if no MON price
  monPriceUsed: number | null;
  lastTradeAt: number | null;
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
};

const QUERY = `query CultMemberStats($ids: [String!]!) {
  Trader(where: { id: { _in: $ids } }) {
    id tradeCount winRate realizedPnlUsd realizedPnlMon lastTradeAt
  }
}`;

interface TraderRow {
  id: string;
  tradeCount: number;
  winRate: number | string;
  realizedPnlUsd: number | string;
  realizedPnlMon: number | string;
  lastTradeAt: number | string | null;
}

const cache = new Map<string, { at: number; stats: MemberStats }>();
const TTL_MS = 15_000;

export function toStats(row: TraderRow | undefined, monPx: number | null): MemberStats {
  if (!row) return UNVERIFIED;
  const perpl = Number(row.realizedPnlUsd ?? 0);
  const mon = Number(row.realizedPnlMon ?? 0);
  return {
    verified: true,
    tradeCount: row.tradeCount,
    winRate: row.tradeCount > 0 ? Number(row.winRate) : null,
    realizedPnlPerplUsd: perpl,
    realizedPnlMon: mon,
    realizedPnlUsd: monPx != null ? perpl + mon * monPx : mon === 0 ? perpl : null,
    monPriceUsed: monPx,
    lastTradeAt: row.lastTradeAt != null ? Number(row.lastTradeAt) : null,
  };
}

// Stats for many wallets in one indexer round trip. Never throws: an
// unconfigured or unreachable indexer means "unverified", not an error page.
export async function statsFor(wallets: string[]): Promise<Map<string, MemberStats>> {
  const out = new Map<string, MemberStats>();
  const ids = [...new Set(wallets.map((w) => w.toLowerCase()))];
  const url = process.env.INDEXER_GRAPHQL_URL;
  const fresh = ids.filter((id) => {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) {
      out.set(id, hit.stats);
      return false;
    }
    return true;
  });
  if (!url || fresh.length === 0) {
    for (const id of fresh) out.set(id, UNVERIFIED);
    return out;
  }
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.INDEXER_GRAPHQL_SECRET) headers['x-hasura-admin-secret'] = process.env.INDEXER_GRAPHQL_SECRET;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query: QUERY, variables: { ids: fresh } }), signal: AbortSignal.timeout(5_000) });
    const body = (await r.json()) as { data?: { Trader?: TraderRow[] }; errors?: { message: string }[] };
    if (!r.ok || body.errors?.length || !body.data?.Trader) throw new Error(body.errors?.[0]?.message ?? `HTTP ${r.status}`);
    const monPx = await monPriceAusd().catch(() => null);
    const rows = new Map(body.data.Trader.map((t) => [t.id.toLowerCase(), t]));
    for (const id of fresh) {
      const stats = toStats(rows.get(id), monPx);
      cache.set(id, { at: Date.now(), stats });
      out.set(id, stats);
    }
  } catch (e) {
    console.warn('[indexer] stats unavailable:', (e as Error).message);
    for (const id of fresh) out.set(id, UNVERIFIED);
  }
  return out;
}
