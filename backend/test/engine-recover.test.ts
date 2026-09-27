// Offline: after a crash, mirrors and adjustments caught mid-send are settled
// by what reached the venue (a fake lookup here; the real one reads receipts
// and Perpl order history, see scripts/e2e/reconcile-read.ts).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);
process.env.MIRROR_RECONCILE_RECHECK_MS = '40';

type Mod = typeof import('../src/mirror/engine.js');
type Landed = import('../src/mirror/reconcile.js').Landed;
let E: Mod, repo: typeof import('../src/mirror/repo.js');
let clanId = '';

const answers = new Map<string, Landed[]>(); // `${kind}:${refId}` -> answers, one per lookup (last one repeats)
const asked: string[] = [];
const sent: { kind: 'open' | 'close'; userId: string; sizeRaw?: string }[] = [];
const held = new Set<string>();
const fake = {
  venue: 'nadfun' as const,
  async open(i: any) {
    sent.push({ kind: 'open', userId: i.userId });
    held.add(`${i.userId}:${i.market}`);
    i.onRef?.({ txHash: '0x' + String(sent.length).padStart(64, '0'), wallet: '0xabc' });
    return { venue: 'nadfun', market: i.market, side: 'buy', sizeRaw: '5000', size: 5, priceAusd: 1, notionalAusd: i.notionalAusd, txHash: '0xnew' };
  },
  async close(i: any) {
    sent.push({ kind: 'close', userId: i.userId, sizeRaw: i.sizeRaw });
    return { venue: 'nadfun', market: i.market, side: 'buy', sizeRaw: i.sizeRaw ?? '0', size: 0, priceAusd: 1, notionalAusd: 1, txHash: '0xsold' };
  },
  async holdings(userId: string, markets: string[] = []) {
    return markets.filter((m) => held.has(`${userId}:${m}`)).map((m) => ({ venue: 'nadfun', market: m, sizeRaw: '10000', size: 10, markPriceAusd: 1 }) as any);
  },
  async freeBalanceAusd() { return 1000; },
  async markPriceAusd() { return 1; },
  async maxLeverage() { return 1; },
};

let n = 0;
const token = () => '0x' + (++n).toString(16).padStart(40, 'a');
function trade(ageMs = 0, closed = false) {
  const t = repo.trades.insert({ id: `t${++n}`, venue: 'nadfun', userId: 'A', accountId: null, market: token(), side: 'buy', positionId: null, size: '10000', entryPrice: 1, leverage: 100, marginFraction: 0.1, openTx: null, openedAt: Date.now() - ageMs });
  if (closed) repo.trades.markClosed(t.id);
  return repo.trades.get(t.id)!;
}
function mirror(tradeId: string, status: 'submitting' | 'open', size = '10000') {
  const m = repo.mirrors.insertPending({ tradeId, clanId, userId: 'B', skipUntil: Date.now() });
  repo.mirrors.transition(m.id, 'pending', 'submitting');
  if (status === 'open') repo.mirrors.transition(m.id, 'submitting', 'open', { size, notionalUsd: 10, marginUsd: 10 });
  return m.id;
}
function adjustment(m: string, tradeId: string, kind: 'add' | 'reduce', ageMs = 0) {
  const a = repo.adjustments.insert({ mirrorId: m, tradeId, clanId, userId: 'B', kind, ratio: kind === 'add' ? 1.5 : 0.5, skipUntil: Date.now() });
  repo.adjustments.transition(a.id, 'pending', 'submitting');
  if (ageMs) (db()).prepare('UPDATE mirror_adjustments SET created_at = ? WHERE id = ?').run(Date.now() - ageMs, a.id);
  return a.id;
}
let db: () => import('node:sqlite').DatabaseSync;

const ids: Record<string, string> = {};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  E = await import('../src/mirror/engine.js');
  repo = await import('../src/mirror/repo.js');
  const { clans } = await import('../src/store/clans.js');
  const { members } = await import('../src/store/members.js');
  const { getDb } = await import('../src/store/db.js');
  db = getDb;
  for (const u of ['A', 'B']) members.upsert(u, `0x${u.repeat(40).toLowerCase()}`);
  clanId = clans.create('r', 'A', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 }).id;
  clans.join(clanId, 'B', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });

  // State as a crash left it.
  const t1 = trade(); ids.filled = mirror(t1.id, 'submitting');
  answers.set(`mirror_open:${ids.filled}`, [{ state: 'filled', sizeRaw: '777', notionalUsd: 7, txHash: '0xlanded', orderId: null }]);
  const t2 = trade(); ids.retry = mirror(t2.id, 'submitting');
  answers.set(`mirror_open:${ids.retry}`, [{ state: 'none' }]);
  const t3 = trade(10 * 60_000); ids.stale = mirror(t3.id, 'submitting');
  answers.set(`mirror_open:${ids.stale}`, [{ state: 'none' }]);
  const t4 = trade(); ids.failed = mirror(t4.id, 'submitting');
  answers.set(`mirror_open:${ids.failed}`, [{ state: 'failed', reason: 'reverted (0xdead)' }]);
  const t5 = trade(); ids.slow = mirror(t5.id, 'submitting');
  answers.set(`mirror_open:${ids.slow}`, [{ state: 'pending' }, { state: 'pending' }, { state: 'filled', sizeRaw: '888', notionalUsd: 8, txHash: '0xlate', orderId: null }]);

  const t6 = trade(); ids.redMirror = mirror(t6.id, 'open'); held.add(`B:${t6.market}`);
  ids.redLanded = adjustment(ids.redMirror, t6.id, 'reduce');
  answers.set(`mirror_reduce:${ids.redLanded}`, [{ state: 'filled', sizeRaw: '4000', notionalUsd: 4, txHash: '0xhalf', orderId: null }]);
  const t7 = trade(); ids.redMirror2 = mirror(t7.id, 'open'); held.add(`B:${t7.market}`);
  ids.redNone = adjustment(ids.redMirror2, t7.id, 'reduce', 60 * 60_000);
  answers.set(`mirror_reduce:${ids.redNone}`, [{ state: 'none' }]);
  const t8 = trade(); ids.addMirror = mirror(t8.id, 'open');
  ids.addStale = adjustment(ids.addMirror, t8.id, 'add', 60 * 60_000);
  answers.set(`mirror_add:${ids.addStale}`, [{ state: 'none' }]);

  const t9 = trade(0, true); ids.exitLanded = mirror(t9.id, 'open'); held.add(`B:${t9.market}`);
  answers.set(`mirror_close:${ids.exitLanded}`, [{ state: 'filled', sizeRaw: '10000', notionalUsd: 9, txHash: '0xgone', orderId: null }]);
  const t10 = trade(0, true); ids.exitMissing = mirror(t10.id, 'open'); held.add(`B:${t10.market}`);
  answers.set(`mirror_close:${ids.exitMissing}`, [{ state: 'none' }]);

  const engine = new E.MirrorEngine(
    { optOutSeconds: 0, minMirrorAusd: 1 },
    {
      sessionFor: async () => { throw new Error('no sessions'); },
      venue: () => fake as any,
      nadWatcher: null,
      landed: async (_v, kind, refId) => {
        const k = `${kind}:${refId}`;
        asked.push(k);
        const q = answers.get(k) ?? [{ state: 'none' }];
        return q.length > 1 ? q.shift()! : q[0]!;
      },
    },
  );
  await engine.start();
  await engine.recovered();
  await wait(300);
});

test('a mirror whose buy landed is booked open from the chain', () => {
  const m = repo.mirrors.get(ids.filled)!;
  assert.equal(m.status, 'open');
  assert.equal(m.size, '777');
  assert.equal(m.openTx, '0xlanded');
});

test('nothing reached the venue and the leader move is fresh: tried again', () => {
  const m = repo.mirrors.get(ids.retry)!;
  assert.equal(m.status, 'open');
  assert.equal(m.size, '5000', 'filled by the retry');
});

test('nothing reached the venue and the move is old: cancelled, nothing sent', () => {
  const m = repo.mirrors.get(ids.stale)!;
  assert.equal(m.status, 'cancelled');
  assert.match(m.error!, /too late/);
});

test('a send that reached the venue and failed is failed, not retried', () => {
  const m = repo.mirrors.get(ids.failed)!;
  assert.equal(m.status, 'failed');
  assert.match(m.error!, /reverted/);
});

test('a tx still in flight is looked at again until it settles', () => {
  const m = repo.mirrors.get(ids.slow)!;
  assert.equal(m.status, 'open');
  assert.equal(m.size, '888');
  assert.equal(asked.filter((k) => k === `mirror_open:${ids.slow}`).length, 3);
});

test('a partial sell that landed is booked; one that did not is sent again, however old', () => {
  assert.equal(repo.adjustments.get(ids.redLanded)!.status, 'done');
  assert.equal(repo.mirrors.get(ids.redMirror)!.size, '6000');
  assert.equal(repo.adjustments.get(ids.redNone)!.status, 'done');
  assert.ok(sent.some((s) => s.kind === 'close' && s.sizeRaw === '5000'), 'the half sell went out after the restart');
});

test('an add that never went out and is now old is cancelled', () => {
  const a = repo.adjustments.get(ids.addStale)!;
  assert.equal(a.status, 'cancelled');
  assert.match(a.error!, /too late/);
});

test('an exit that already landed is recorded, never sold twice; a missing one is sent', () => {
  const landed = repo.mirrors.get(ids.exitLanded)!;
  assert.equal(landed.status, 'closed');
  assert.equal(landed.closeTx, '0xgone');
  const missing = repo.mirrors.get(ids.exitMissing)!;
  assert.equal(missing.status, 'closed');
  assert.equal(missing.closeTx, '0xsold');
  assert.equal(sent.filter((s) => s.kind === 'close' && s.sizeRaw === '10000').length, 1, 'exactly one exit sold');
});

test('a manual stack caught mid-send is settled, never re-sent', async () => {
  const { reconcileStacks } = await import('../src/mirror/stack.js');
  const t = trade();
  const put = (id: string) =>
    db().prepare(`INSERT INTO stacks (id, venue, clan_id, user_id, target_trade, market, side, notional_usd, leverage, status, created_at) VALUES (?, 'nadfun', ?, 'B', ?, ?, 'buy', 5, 100, 'submitting', ?)`).run(id, clanId, t.id, t.market, Date.now());
  put('s-filled');
  put('s-none');
  const before = sent.length;
  await reconcileStacks(async (_v, kind, refId) => (refId === 's-filled' && kind === 'stack_open' ? { state: 'filled', sizeRaw: '42', notionalUsd: 5, txHash: '0xstk', orderId: null } : { state: 'none' }), 10, 1);
  const row = (id: string) => db().prepare('SELECT status, size, open_tx, error FROM stacks WHERE id = ?').get(id) as { status: string; size: string; open_tx: string; error: string };
  assert.deepEqual([row('s-filled').status, row('s-filled').size, row('s-filled').open_tx], ['open', '42', '0xstk']);
  assert.equal(row('s-none').status, 'failed');
  assert.match(row('s-none').error, /nothing reached/);
  assert.equal(sent.length, before, 'nothing sent on the member\'s behalf');
});
