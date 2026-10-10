import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import type { MirrorEngine } from '../../src/mirror/engine.js';
import type { TradingSession } from '../../src/perpl/session.js';
import type { Position, Account } from '../../src/perpl/types.js';
import type { LeaderTrade } from '../../src/mirror/repo.js';
import type { LandedLookup } from '../../src/mirror/reconcile.js';
import type { CloseInput, Fill, Holding, OpenInput, Venue, VenueAdapter } from '../../src/venues/types.js';

process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.KEY_ENCRYPTION_SECRET = '00'.repeat(32);
process.env.PERPL_CHAIN_ID = '10143';
process.env.PERPL_API_URL = 'https://own-orders.invalid/api';

const engines: MirrorEngine[] = [];
const unexpected: string[] = [];
let serial = 1000;
export const flush = () => new Promise<void>(resolve => setImmediate(resolve));
export const meme = `0x${'a'.repeat(40)}`;
export const marketFor = (v: Venue) => v === 'perpl' ? '16' : meme;
export const sideFor = (v: Venue) => v === 'perpl' ? 'long' as const : 'buy' as const;

export function installOfflineFetch() {
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'https://own-orders.invalid/api/v1/pub/context') {
      if (url === 'https://own-orders.invalid/api/v1/market-data/ticker') {
        return Response.json({ sn: 1, d: { '16': { mrk: 1 }, '32': { mrk: 1 } } });
      }
      unexpected.push(url);
      throw new Error('unexpected network access in own-order tests');
    }
    return Response.json({ chain: { chain_id: 10143 },
      instances: [{ address: '0x1', collateral_token_id: 1, min_account_open_amount: '100000000', min_deposit_amount: '10000000' }],
      tokens: [{ id: 1, address: '0x2', decimals: 6 }],
      markets: [16, 32].map(id => ({ id, symbol: id === 16 ? 'BTC' : 'ETH',
        config: { is_open: true, price_decimals: 0, size_decimals: 0, initial_margin: 1000, maker_fee: 0, taker_fee: 0 } })),
    });
  });
}

export function stopFixtures() {
  for (const engine of engines.splice(0)) engine.stop();
}

export function verifyOffline() {
  stopFixtures();
  assert.deepEqual(unexpected, [], 'all network calls must be explicitly mocked');
  mock.restoreAll();
}

export function makeSession(accountId: number) {
  return Object.assign(new EventEmitter(), {
    positions: new Map<string, Position>(),
    accounts: new Map<number, Account>([[accountId, { id: accountId, b: '1000000000', lb: '0' } as Account]]),
  }) as unknown as TradingSession;
}

export function fill(v: Venue, raw: string, patch: Partial<Fill> = {}): Fill {
  return { venue: v, market: marketFor(v), side: sideFor(v), sizeRaw: raw, size: Number(raw),
    priceAusd: 1, notionalAusd: Number(raw), ...patch };
}

export function holding(v: Venue, raw: string, patch: Partial<Holding> = {}): Holding {
  return { venue: v, market: marketFor(v), side: sideFor(v), symbol: v === 'perpl' ? 'BTC-PERP' : '$TEST',
    sizeRaw: raw, size: Number(raw), entryPriceAusd: 1, markPriceAusd: 2,
    valueAusd: Number(raw) * 2, pnlAusd: Number(raw), leverage: v === 'perpl' ? 2 : 1, ...patch };
}

export async function ownFixture() {
  const { MirrorEngine } = await import('../../src/mirror/engine.js');
  const { members } = await import('../../src/store/members.js');
  const { clans } = await import('../../src/store/clans.js');
  const repo = await import('../../src/mirror/repo.js');
  const { memberOrders } = await import('../../src/mirror/member-orders.js');
  const { allocatedHoldings } = await import('../../src/mirror/allocations.js');
  const { getDb } = await import('../../src/store/db.js');
  assert.ok(getDb().prepare('PRAGMA database_list').all().every(row => row.file === ''), 'memory-only SQLite');
  const user = `own-${++serial}`;
  const shared = `shared-${++serial}`;
  const followerA = `a-${++serial}`;
  const followerB = `b-${++serial}`;
  const stranger = `stranger-${++serial}`;
  const sessions = new Map<string, TradingSession>();
  for (const id of [user, shared, followerA, followerB, stranger]) {
    members.upsert(id, `0x${(++serial).toString(16).padStart(40, '0')}`);
    members.setAccount(id, ++serial);
    members.setApiKey(id, 'offline-key', new Uint8Array(32), 'offline-pubkey');
    members.setForwarding(id, true);
    sessions.set(id, makeSession(members.get(id)!.perplAccountId!));
  }
  const on = { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 10000 };
  const off = { ...on, enabled: false };
  const cultA = clans.create('A', user, off).id;
  const cultB = clans.create('B', user, off).id;
  clans.join(cultA, shared, on); clans.join(cultB, shared, on);
  clans.join(cultA, followerA, on); clans.join(cultB, followerB, on);
  const holdings = new Map<string, Holding>();
  const opens: OpenInput[] = [], closes: CloseInput[] = [];
  const key = (userId: string, v: Venue, market: string) => `${userId}:${v}:${market.toLowerCase()}`;
  const controls: {
    open?: (input: OpenInput, proposed: Fill) => Promise<Fill> | Fill;
    close?: (input: CloseInput, proposed: Fill) => Promise<Fill> | Fill;
    holdingsError?: Error;
    free?: number;
  } = {};
  const put = (userId: string, h: Holding) => holdings.set(key(userId, h.venue, h.market), h);
  const adapters = Object.fromEntries((['perpl', 'nadfun'] as const).map(v => [v, {
    venue: v,
    async holdings(userId: string, markets?: string[]) {
      if (controls.holdingsError) throw controls.holdingsError;
      return [...holdings.entries()].filter(([k, h]) => k.startsWith(`${userId}:${v}:`) &&
        BigInt(h.sizeRaw) > 0n && (!markets || markets.some(m => m.toLowerCase() === h.market.toLowerCase()))).map(([, h]) => ({ ...h }));
    },
    async freeBalanceAusd() { return controls.free ?? 1000; },
    async markPriceAusd() { return 1; },
    async maxLeverage() { return v === 'perpl' ? 10 : 1; },
    async open(input: OpenInput) {
      opens.push(input);
      const rq = ++serial;
      const txHash = `0x${rq.toString(16).padStart(64, '0')}`;
      input.onRef?.(v === 'perpl' ? { rq, accountId: members.get(input.userId)!.perplAccountId! } : { txHash, wallet: members.get(input.userId)!.wallet });
      const proposed = fill(v, String(Math.round(input.notionalAusd)), { market: input.market, side: input.side,
        requestId: v === 'perpl' ? rq : undefined, orderId: rq, txHash });
      const result = controls.open ? await controls.open(input, proposed) : proposed;
      const previous = holdings.get(key(input.userId, v, input.market));
      if (BigInt(result.sizeRaw) > 0n) put(input.userId, holding(v, String(BigInt(previous?.sizeRaw ?? '0') + BigInt(result.sizeRaw)),
        { market: input.market.toLowerCase(), side: input.side, leverage: input.leverage ?? 1 }));
      return result;
    },
    async close(input: CloseInput) {
      closes.push(input);
      const previous = holdings.get(key(input.userId, v, input.market));
      const rq = ++serial;
      const txHash = `0x${rq.toString(16).padStart(64, '0')}`;
      input.onRef?.(v === 'perpl' ? { rq, accountId: members.get(input.userId)!.perplAccountId! } : { txHash, wallet: members.get(input.userId)!.wallet });
      const proposed = fill(v, input.sizeRaw ?? previous?.sizeRaw ?? '0', { market: input.market,
        side: previous?.side ?? input.side ?? sideFor(v), requestId: v === 'perpl' ? rq : undefined, orderId: rq, txHash });
      const result = controls.close ? await controls.close(input, proposed) : proposed;
      const latest = holdings.get(key(input.userId, v, input.market));
      const left = BigInt(latest?.sizeRaw ?? '0') - BigInt(result.sizeRaw);
      if (latest && BigInt(result.sizeRaw) > 0n) put(input.userId, { ...latest, sizeRaw: String(left > 0n ? left : 0n),
        size: Number(left > 0n ? left : 0n), valueAusd: Number(left > 0n ? left : 0n) * latest.markPriceAusd });
      return result;
    },
  } satisfies VenueAdapter])) as Record<Venue, VenueAdapter>;
  const makeEngine = (landed: LandedLookup = async () => ({ state: 'none' })) => {
    const engine = new MirrorEngine({ optOutSeconds: 3600, minMirrorAusd: 1 }, {
      sessionFor: async id => { assert.ok(sessions.has(id)); return sessions.get(id)!; },
      venue: v => adapters[v], nadWatcher: null, landed,
    });
    engines.push(engine);
    return engine;
  };
  const engine = makeEngine();
  const orders = (id = user) => getDb().prepare('SELECT id FROM member_orders WHERE user_id = ? ORDER BY rowid').all(id)
    .map(row => memberOrders.get(row.id as string)!);
  const ownOpen = (v: Venue = 'perpl', cultIds: string[] = [], raw = 100, userId = user) =>
    engine.executeOwnOpen({ userId, market: marketFor(v), side: sideFor(v), notionalAusd: raw, leverage: v === 'perpl' ? 2 : 1 }, cultIds);
  const seedTrade = (raw: string, patch: Partial<LeaderTrade> = {}) => repo.trades.insert({
    id: randomUUID(), venue: 'perpl', userId: user, accountId: members.get(user)!.perplAccountId,
    market: '16', side: 'long', positionId: null, size: raw, entryPrice: 1, leverage: 200,
    marginFraction: 0.1, openTx: null, openedAt: Date.now(), cultIds: [cultA], ...patch,
  });
  const seedMirror = (t: LeaderTrade, raw: string, userId = user) => {
    const m = repo.mirrors.insertPending({ tradeId: t.id, clanId: cultA, userId, skipUntil: Date.now() + 3600000 });
    repo.mirrors.transition(m.id, 'pending', 'submitting');
    return repo.mirrors.transition(m.id, 'submitting', 'open', { size: raw, notionalUsd: Number(raw), marginUsd: Number(raw) / 2 })!;
  };
  const seedStack = (t: LeaderTrade, raw: string, userId = user) => {
    const id = randomUUID();
    getDb().prepare(`INSERT INTO stacks (id, venue, clan_id, user_id, target_trade, market, side, size, notional_usd, leverage, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 200, 'open', ?)`).run(id, t.venue, cultA, userId, t.id, t.market, t.side, raw, Number(raw), Date.now());
    return id;
  };
  return { engine, makeEngine, user, shared, followerA, followerB, stranger, cultA, cultB, members, clans,
    repo, memberOrders, allocatedHoldings, getDb, adapters, holdings, sessions, controls, opens, closes,
    put, orders, ownOpen, seedTrade, seedMirror, seedStack };
}
