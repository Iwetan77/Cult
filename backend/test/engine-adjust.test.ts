// Offline: a leader adding to or partly exiting a trade they lead, and how
// open mirrors follow. Fake venue with real raw-size bookkeeping.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

type Mod = typeof import('../src/mirror/engine.js');
let E: Mod, clans: typeof import('../src/store/clans.js')['clans'], members: typeof import('../src/store/members.js')['members'];
let repo: typeof import('../src/mirror/repo.js');
let origin: typeof import('../src/mirror/origin.js');

// 1 token = 1000 raw, mark $1, so $N buys N*1000 raw.
const held = new Map<string, bigint>(); // `${user}:${market}` -> raw
const sent: { kind: 'open' | 'close'; userId: string; market: string; raw: bigint; usd: number }[] = [];
const balances: Record<string, number> = { A: 1000, B: 1000, C: 1000 };
let n = 0;
const fake = {
  venue: 'nadfun' as const,
  async open(i: any) {
    const raw = BigInt(Math.round(i.notionalAusd * 1000));
    const k = `${i.userId}:${i.market}`;
    held.set(k, (held.get(k) ?? 0n) + raw);
    const txHash = `0x${(++n).toString(16).padStart(64, '0')}`;
    i.onRef?.({ txHash, wallet: '0xabc' });
    sent.push({ kind: 'open', userId: i.userId, market: i.market, raw, usd: i.notionalAusd });
    return { venue: 'nadfun', market: i.market, side: 'buy', sizeRaw: raw.toString(), size: Number(raw) / 1000, priceAusd: 1, notionalAusd: i.notionalAusd, txHash };
  },
  async close(i: any) {
    const k = `${i.userId}:${i.market}`;
    const have = held.get(k) ?? 0n;
    const raw = i.sizeRaw != null ? BigInt(i.sizeRaw) : have;
    held.set(k, have - raw);
    const txHash = `0x${(++n).toString(16).padStart(64, '0')}`;
    i.onRef?.({ txHash, wallet: '0xabc' });
    sent.push({ kind: 'close', userId: i.userId, market: i.market, raw, usd: Number(raw) / 1000 });
    return { venue: 'nadfun', market: i.market, side: 'buy', sizeRaw: raw.toString(), size: Number(raw) / 1000, priceAusd: 1, notionalAusd: Number(raw) / 1000, txHash };
  },
  async holdings(userId: string, markets: string[] = []) {
    return markets
      .filter((m) => (held.get(`${userId}:${m}`) ?? 0n) > 0n)
      .map((m) => {
        const raw = held.get(`${userId}:${m}`)!;
        return { venue: 'nadfun', market: m, symbol: '$TEST', side: 'buy', sizeRaw: raw.toString(), size: Number(raw) / 1000,
          entryPriceAusd: 1, markPriceAusd: 1, valueAusd: Number(raw) / 1000, pnlAusd: 0, leverage: 1 };
      });
  },
  async freeBalanceAusd(userId: string) { return balances[userId] ?? 0; },
  async markPriceAusd() { return 1; },
  async maxLeverage() { return 1; },
};

let engine: InstanceType<Mod['MirrorEngine']>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = (c: string) => '0x' + c.repeat(40).slice(0, 40);
const mirrorOf = (tradeId: string, userId: string) => repo.mirrors.forTrade(tradeId).find((m) => m.userId === userId)!;

before(async () => {
  E = await import('../src/mirror/engine.js');
  ({ clans } = await import('../src/store/clans.js'));
  ({ members } = await import('../src/store/members.js'));
  repo = await import('../src/mirror/repo.js');
  origin = await import('../src/mirror/origin.js');
  for (const u of ['A', 'B', 'C']) members.upsert(u, `0x${u.repeat(40).toLowerCase()}`);
  const clan = clans.create('adj', 'A', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  clans.join(clan.id, 'B', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  clans.join(clan.id, 'C', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 30 });
  engine = new E.MirrorEngine({ optOutSeconds: 0.2, minMirrorAusd: 1 }, { sessionFor: async () => { throw new Error('no sessions'); }, venue: () => fake as any, nadWatcher: null });
});

after(() => engine.stop());

// Leader A buys 10% of their dollars; B and C mirror at 10% of 1000 = $100 (C capped at $30).
async function leaderBuys(market: string) {
  held.set(`A:${market}`, 100_000n);
  const t = (await engine.leaderOpened({ venue: 'nadfun', userId: 'A', market, side: 'buy', sizeRaw: '100000', entryPriceAusd: 1, leverageHundredths: 100, marginFraction: 0.1 }))!;
  await wait(350);
  assert.equal(mirrorOf(t.id, 'B').size, '100000');
  assert.equal(mirrorOf(t.id, 'C').size, '30000');
  return t;
}

test('a partial sell goes straight out: each mirror sells the same share of itself', async () => {
  const mkt = token('a1');
  const t = await leaderBuys(mkt);
  await engine.leaderResized(repo.trades.get(t.id)!, 60_000n, 1); // leader sold 40%
  await wait(50);
  const b = mirrorOf(t.id, 'B');
  const c = mirrorOf(t.id, 'C');
  assert.equal(b.size, '60000');
  assert.equal(c.size, '18000');
  assert.equal(b.status, 'open');
  assert.equal(Math.round(b.notionalUsd!), 60, 'cost basis follows the size, entry price unchanged');
  assert.equal(repo.trades.get(t.id)!.size, '60000', 'leader marker shows what they still hold');
  const adj = repo.adjustments.forMirror(b.id);
  assert.equal(adj.length, 1);
  assert.equal(adj[0]!.kind, 'reduce');
  assert.equal(adj[0]!.status, 'done');
  assert.equal(adj[0]!.sizeDelta, '40000');
  assert.ok(origin.isEngineTx(adj[0]!.tx!), 'the mirror sell is tagged so it is never read as B leading');
});

test('an add waits out the skip window; a skip keeps that member out of it', async () => {
  const mkt = token('a2');
  const t = await leaderBuys(mkt);
  await engine.leaderResized(repo.trades.get(t.id)!, 150_000n, 1); // leader added 50%
  const pendB = repo.adjustments.forMirror(mirrorOf(t.id, 'B').id)[0]!;
  assert.equal(pendB.kind, 'add');
  assert.equal(pendB.status, 'pending');
  assert.throws(() => engine.skipAdjustment(pendB.id, 'C'), /not found/, 'only the owner can skip');
  engine.skipAdjustment(pendB.id, 'B');
  await wait(350);
  assert.equal(repo.adjustments.get(pendB.id)!.status, 'skipped');
  assert.equal(mirrorOf(t.id, 'B').size, '100000', 'B skipped the add');
  const c = mirrorOf(t.id, 'C');
  const addC = repo.adjustments.forMirror(c.id)[0]!;
  assert.equal(addC.status, 'done');
  assert.equal(c.size, '45000', 'C adds half of its $30 mirror');
});

test('adds are capped like a new mirror', async () => {
  const mkt = token('a3');
  const t = await leaderBuys(mkt);
  await engine.leaderResized(repo.trades.get(t.id)!, 400_000n, 1); // leader 4x'd
  await wait(350);
  const b = mirrorOf(t.id, 'B');
  const c = mirrorOf(t.id, 'C');
  assert.equal(b.size, '400000', 'B: +$300, inside its caps');
  const addC = repo.adjustments.forMirror(c.id)[0]!;
  assert.equal(c.size, '60000', 'C wanted +$90 but one add is capped at $30');
  assert.match(addC.error!, /max_usd_per_trade/);
});

test('a skipped add then a partial sell: the member sells the leader\'s share of what they hold', async () => {
  const mkt = token('a4');
  const t = await leaderBuys(mkt);
  await engine.leaderResized(repo.trades.get(t.id)!, 200_000n, 1); // leader doubles
  const b = mirrorOf(t.id, 'B');
  engine.skipAdjustment(repo.adjustments.forMirror(b.id)[0]!.id, 'B');
  await wait(350);
  await engine.leaderResized(repo.trades.get(t.id)!, 150_000n, 1); // then sells a quarter
  await wait(50);
  assert.equal(mirrorOf(t.id, 'B').size, '75000', 'B never added, so it sells a quarter of 100k');
});

test('a member who sold some by hand is never sold below zero', async () => {
  const mkt = token('a5');
  const t = await leaderBuys(mkt);
  held.set(`B:${mkt}`, 10_000n); // B sold 90% on their own
  await engine.leaderResized(repo.trades.get(t.id)!, 50_000n, 1); // leader sells half
  await wait(50);
  const b = mirrorOf(t.id, 'B');
  const adj = repo.adjustments.forMirror(b.id)[0]!;
  assert.equal(adj.sizeDelta, '5000', 'sold half the live remaining slice, never the stale recorded 100k');
  assert.equal(held.get(`B:${mkt}`), 5000n);
  assert.equal(b.size, '50000', 'half the recorded copy corresponds to half its available balance');
});

test('the exit after a partial sell closes what is left, not the original size', async () => {
  const mkt = token('a6');
  const t = await leaderBuys(mkt);
  await engine.leaderResized(repo.trades.get(t.id)!, 30_000n, 1); // sells 70%
  await wait(50);
  const closesBefore = sent.filter((s) => s.kind === 'close' && s.market === mkt).length;
  await engine.closeTrade(repo.trades.get(t.id)!);
  const b = mirrorOf(t.id, 'B');
  assert.equal(b.status, 'closed');
  const exits = sent.filter((s) => s.kind === 'close' && s.market === mkt).slice(closesBefore);
  assert.deepEqual(exits.find((s) => s.userId === 'B')!.raw, 30_000n);
  assert.equal(held.get(`B:${mkt}`), 0n);
});

test('a leader change during the skip window sizes the mirror to where the leader is now', async () => {
  const mkt = token('a7');
  held.set(`A:${mkt}`, 100_000n);
  const t = (await engine.leaderOpened({ venue: 'nadfun', userId: 'A', market: mkt, side: 'buy', sizeRaw: '100000', entryPriceAusd: 1, leverageHundredths: 100, marginFraction: 0.1 }))!;
  await engine.leaderResized(repo.trades.get(t.id)!, 50_000n, 1); // sells half before anyone mirrored
  assert.equal(repo.adjustments.forTrade(t.id, ['pending', 'done', 'submitting']).length, 0, 'nothing to adjust yet');
  await wait(350);
  assert.equal(mirrorOf(t.id, 'B').size, '50000', 'B opened at 5% (10% x the leader\'s half), not 10%');
});

test('a pending add is cancelled when the leader exits, and when the member leaves', async () => {
  const mkt = token('a8');
  const t = await leaderBuys(mkt);
  await engine.leaderResized(repo.trades.get(t.id)!, 200_000n, 1);
  const addC = repo.adjustments.forMirror(mirrorOf(t.id, 'C').id)[0]!;
  const clanId = mirrorOf(t.id, 'C').clanId;
  engine.memberLeft(clanId, 'C');
  assert.equal(repo.adjustments.get(addC.id)!.status, 'cancelled');
  assert.match(repo.adjustments.get(addC.id)!.error!, /left/);
  await engine.closeTrade(repo.trades.get(t.id)!);
  const addB = repo.adjustments.forMirror(mirrorOf(t.id, 'B').id)[0]!;
  assert.equal(addB.status, 'cancelled');
  await wait(350);
  assert.equal(mirrorOf(t.id, 'B').status, 'closed');
  assert.equal(mirrorOf(t.id, 'B').size, '100000', 'no add slipped in after the exit');
  clans.join(clanId, 'C', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 30 });
});

test('selling down to under 1% of the trade counts as the exit', async () => {
  const mkt = token('a9');
  const t = await leaderBuys(mkt);
  await engine.leaderResized(repo.trades.get(t.id)!, 900n, 1);
  assert.ok(repo.trades.get(t.id)!.closedAt);
  assert.equal(mirrorOf(t.id, 'B').status, 'closed');
});

test('capAdd: dollar cap, then balance share, then the minimum', () => {
  const p = { balancePercentCap: 10, maxUsdPerTrade: 50 };
  assert.deepEqual(E.capAdd(20, 1, 1000, p, 1), { ok: true, notionalUsd: 20, capsApplied: [] });
  assert.deepEqual(E.capAdd(80, 1, 1000, p, 1), { ok: true, notionalUsd: 50, capsApplied: ['max_usd_per_trade'] });
  assert.deepEqual(E.capAdd(40, 1, 100, p, 1), { ok: true, notionalUsd: 10, capsApplied: ['balance_percent_cap'] });
  assert.equal(E.capAdd(40, 1, 5, p, 1).ok, false);
});
