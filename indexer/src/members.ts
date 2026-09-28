// Cult members only. The indexer exists to serve verified records for Cult
// members, and Perpl testnet alone emits ~150k position events a day from
// market-making bots: storing everyone's history fills a small database in
// minutes and nobody reads it. So Perpl accounts and Nad.fun wallets are only
// tracked when they belong to a member.
//
// The list comes from the backend: GET {CULT_API_URL}/v1/indexer/accounts with
// X-Indexer-Key: {INDEXER_API_KEY}. Without CULT_API_URL every wallet is
// indexed (local runs and the handler tests).
//
// A record starts when the member is on the list: trades from before they
// joined Cult (or before the indexer's start block) aren't counted.

const API = process.env.CULT_API_URL?.replace(/\/+$/, "");
const KEY = process.env.INDEXER_API_KEY ?? "";

// A hit is trusted for a minute (members rarely leave, and indexing a leaver a
// little longer is harmless). A miss re-asks after 5s, so someone who has just
// joined is picked up before their first trade is skipped.
const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 5_000;
const GIVE_UP_MS = 5 * 60_000;

interface MemberList {
  at: number;
  wallets: Set<string>;
  perplOwners: Map<string, string>; // perpl account id -> member wallet
}

let list: MemberList | undefined;
let loading: Promise<MemberList> | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchList(): Promise<MemberList> {
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${API}/v1/indexer/accounts`, {
        headers: { "X-Indexer-Key": KEY },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 403 ? " (INDEXER_API_KEY doesn't match the backend's)" : ""}`);
      const body = (await r.json()) as { accounts: { wallet: string | null; perplAccountId: number | string | null }[] };
      const wallets = new Set<string>();
      const perplOwners = new Map<string, string>();
      for (const a of body.accounts) {
        if (!a.wallet) continue;
        const wallet = a.wallet.toLowerCase();
        wallets.add(wallet);
        if (a.perplAccountId != null) perplOwners.set(String(a.perplAccountId), wallet);
      }
      return { at: Date.now(), wallets, perplOwners };
    } catch (e) {
      // Never guess: skipping a member's trade would lose it for good. Wait for
      // the backend, and crash (the host restarts us) if it stays away.
      const reason = (e as Error).message;
      if (Date.now() - started > GIVE_UP_MS) throw new Error(`[members] member list unavailable: ${reason}`);
      console.warn(`[members] member list unavailable, retrying: ${reason}`);
      await sleep(5_000);
    }
  }
}

async function current(maxAgeMs: number): Promise<MemberList> {
  if (list && Date.now() - list.at < maxAgeMs) return list;
  loading ??= fetchList()
    .then((l) => (list = l))
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

export const membersOnly = Boolean(API);

// Is this wallet a Cult member's? Always true without a backend configured.
export async function isMember(wallet: string): Promise<boolean> {
  if (!API) return true;
  const w = wallet.toLowerCase();
  if ((await current(HIT_TTL_MS)).wallets.has(w)) return true;
  return (await current(MISS_TTL_MS)).wallets.has(w);
}

// The member wallet behind a Perpl account id, or null if it isn't a member's.
export async function memberOfPerplAccount(accountId: bigint): Promise<string | null> {
  if (!API) return null;
  const id = accountId.toString();
  const hit = (await current(HIT_TTL_MS)).perplOwners.get(id);
  if (hit) return hit;
  return (await current(MISS_TTL_MS)).perplOwners.get(id) ?? null;
}
