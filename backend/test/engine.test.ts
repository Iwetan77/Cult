// Offline logic test for the mirror engine: fake venue adapters, in-memory DB.
// This is NOT the Phase 4 gate (that one reads real venues). It pins down the
// engine's own rules: who gets a mirror, skip, caps, close propagation, and
// that orders the engine sends are tagged so they never become leader trades.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

type Mod = typeof import('../src/mirror/engine.js');
let E: Mod, clans: typeof import('../src/store/clans.js')['clans'], members: typeof import('../src/store/members.js')['members'];
let mirrors: typeof import('../src/mirror/repo.js')['mirrors'], trades: typeof import('../src/mirror/repo.js')['trades'];
let origin: typeof import('../src/mirror/origin.js');

const opens: { venue: string; userId: string; market: string; notionalAusd: number; leverage?: number }[] = [];
const closes: { venue: string; userId: string; market: string; sizeRaw?: string }[] = [];
let n = 0;
const fake = (v: 'perpl' | 'nadfun', balances: Record<string, number>) => ({
  venue: v,
  async open(i: any) {
    opens.push({ venue: v, userId: i.userId, market: i.market, notionalAusd: i.notionalAusd, leverage: i.leverage });
    const ref = v === 'perpl' ? { rq: ++n, accountId: 1000 + n } : { txHash: `0x${(++n).toString(16).padStart(64, '0')}`, wallet: '0xabc' };
    i.onRef?.(ref);
    return { venue: v, market: i.market, side: i.side, sizeRaw: String(Math.round(i.notionalAusd * 1000)), size: i.notionalAusd, priceAusd: 1, notionalAusd: i.notionalAusd, txHash: (ref as any).txHash ?? null, orderId: n };
  },
  async close(i: any) {
    closes.push({ venue: v, userId: i.userId, market: i.market, sizeRaw: i.sizeRaw });
    return { venue: v, market: i.market, side: 'long', sizeRaw: i.sizeRaw ?? '0', size: 0, priceAusd: 1, notionalAusd: 0, orderId: ++n };
  },
  async holdings() { return []; },
  async freeBalanceAusd(userId: string) { return balances[userId] ?? 0; },
  async markPriceAusd() { return 1; },
  async maxLeverage() { return v === 'perpl' ? 10 : 1; },
});

const bal = { A: 1000, B: 1000, C: 200 };
let engine: InstanceType<Mod['MirrorEngine']>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  E = await import('../src/mirror/engine.js');
  ({ clans } = await import('../src/store/clans.js'));
  ({ members } = await import('../src/store/members.js'));
  ({ mirrors, trades } = await import('../src/mirror/repo.js'));
  origin = await import('../src/mirror/origin.js');
  for (const u of ['A', 'B', 'C', 'D']) members.upsert(u, `0x${u.repeat(40).toLowerCase().slice(0, 40)}`);
  const clan = clans.create('t', 'A', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  clans.join(clan.id, 'B', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  clans.join(clan.id, 'C', { enabled: true, balancePercentCap: 5, maxUsdPerTrade: 15 });
  clans.join(clan.id, 'D', { enabled: false, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  const venues = { perpl: fake('perpl', bal), nadfun: fake('nadfun', bal) } as any;
  engine = new E.MirrorEngine({ optOutSeconds: 0.2, minMirrorAusd: 1 }, { sessionFor: async () => { throw new Error('no sessions in test'); }, venue: (v) => venues[v], nadWatcher: null });
});

test('perpl leader: mirrors for B and C only, sized by own balance and caps', async () => {
  const t = await engine.leaderOpened({ venue: 'perpl', userId: 'A', market: '16', side: 'long', sizeRaw: '100', entryPriceAusd: 100, leverageHundredths: 500, marginFraction: 0.1 });
  assert.ok(t);
  const pend = mirrors.forTrade(t!.id);
  assert.deepEqual(pend.map((m) => m.userId).sort(), ['B', 'C'], 'leader and disabled member D get none');
  assert.ok(pend.every((m) => m.status === 'pending'));
  await wait(400);
  const done = mirrors.forTrade(t!.id);
  const b = done.find((m) => m.userId === 'B')!;
  const c = done.find((m) => m.userId === 'C')!;
  assert.equal(b.status, 'open');
  assert.equal(b.notionalUsd, 500); // 10% of 1000 = 100 margin x5
  assert.equal(c.status, 'open');
  assert.equal(c.notionalUsd, 15); // 5% of 200 = 10 margin x5 = 50, clamped to 15
  assert.match(c.capApplied!, /balance_percent_cap/);
  assert.match(c.capApplied!, /max_usd_per_trade/);
});

test('orders the engine sent are tagged before they leave', () => {
  const open = mirrors.byStatus('open');
  for (const m of open) assert.ok(m.openRq != null && origin.isEngineOrder(1000 + m.openRq, m.openRq), `mirror ${m.id} rq tagged`);
});

test('leader close closes each mirror by its own slice only', async () => {
  const t = trades.openFor('A', 'perpl', '16')!;
  await engine.closeTrade(t);
  const ms = mirrors.forTrade(t.id);
  assert.ok(ms.every((m) => m.status === 'closed'));
  for (const m of ms) assert.ok(closes.some((c) => c.userId === m.userId && c.sizeRaw === m.size));
});

test('skip inside the window prevents the mirror; after the window it is refused', async () => {
  const t = await engine.leaderOpened({ venue: 'nadfun', userId: 'B', market: '0x' + 'ab'.repeat(20), side: 'buy', sizeRaw: '1', entryPriceAusd: 1, leverageHundredths: 100, marginFraction: 0.02 });
  const forA = mirrors.forTrade(t!.id).find((m) => m.userId === 'A')!;
  engine.skip(forA.id, 'A');
  assert.throws(() => engine.skip(forA.id, 'A'), /not pending/);
  const forC = mirrors.forTrade(t!.id).find((m) => m.userId === 'C')!;
  await wait(400);
  assert.equal(mirrors.get(forA.id)!.status, 'skipped');
  assert.throws(() => engine.skip(forC.id, 'C'), /not pending|window/);
  // nadfun: leverage 1, 2% of balance, and C's 4 AUSD is above the 1 AUSD minimum
  const c = mirrors.get(forC.id)!;
  assert.equal(c.status, 'open');
  assert.equal(c.notionalUsd, 4);
  assert.ok(opens.filter((o) => o.venue === 'nadfun').every((o) => (o.leverage ?? 1) === 1));
  const tagged = opens.filter((o) => o.venue === 'nadfun').length;
  assert.ok(tagged >= 1);
});

test('dust mirrors are refused, not fired', async () => {
  const t = await engine.leaderOpened({ venue: 'nadfun', userId: 'A', market: '0x' + 'cd'.repeat(20), side: 'buy', sizeRaw: '1', entryPriceAusd: 1, leverageHundredths: 100, marginFraction: 0.001 });
  await wait(400);
  const c = mirrors.forTrade(t!.id).find((m) => m.userId === 'C')!; // 0.1% of 200 = 0.2 AUSD
  assert.equal(c.status, 'failed');
  assert.match(c.error!, /minimum/);
});

test('a member outside any clan is not a leader', async () => {
  members.upsert('Z', '0x' + '9'.repeat(40));
  assert.equal(await engine.leaderOpened({ venue: 'perpl', userId: 'Z', market: '16', side: 'long', sizeRaw: '1', entryPriceAusd: 1, leverageHundredths: 100, marginFraction: 0.1 }), null);
});
