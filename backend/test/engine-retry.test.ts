// Mirror retry rules: retry only when a failure provably sent nothing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.MIRROR_RETRY_BACKOFF_MS = '40';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

let engine: any, mirrors: any;
let mode: 'flaky-then-ok' | 'fail-after-send' | 'always-fail-before-send' = 'flaky-then-ok';
let balanceCalls = 0;
let openCalls = 0;
let n = 0;

const venue = {
  venue: 'perpl',
  async open(i: any) {
    openCalls++;
    if (mode === 'fail-after-send') {
      i.onRef?.({ rq: ++n, accountId: 7 }); // the order left...
      throw new Error('socket closed with rq in flight'); // ...then the outcome was lost
    }
    i.onRef?.({ rq: ++n, accountId: 7 });
    return { venue: 'perpl', market: i.market, side: i.side, sizeRaw: '10', size: 1, priceAusd: 1, notionalAusd: i.notionalAusd, orderId: n };
  },
  async close() { return { venue: 'perpl', market: '', side: 'long', sizeRaw: '0', size: 0, priceAusd: 0, notionalAusd: 0 }; },
  async holdings() { return []; },
  async freeBalanceAusd() {
    balanceCalls++;
    if (mode === 'always-fail-before-send' || (mode === 'flaky-then-ok' && balanceCalls <= 2)) throw new Error('fetch failed (ETIMEDOUT)');
    return 1000;
  },
  async markPriceAusd() { return 1; },
  async maxLeverage() { return 10; },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function leaderTrade(market: string) {
  const t = await engine.leaderOpened({ venue: 'perpl', userId: 'A', market, side: 'long', sizeRaw: '1', entryPriceAusd: 1, leverageHundredths: 200, marginFraction: 0.1 });
  return mirrors.forTrade(t.id).find((m: any) => m.userId === 'B');
}

before(async () => {
  const { MirrorEngine } = await import('../src/mirror/engine.js');
  const { clans } = await import('../src/store/clans.js');
  const { members } = await import('../src/store/members.js');
  ({ mirrors } = await import('../src/mirror/repo.js'));
  members.upsert('A', '0x' + 'a'.repeat(40));
  members.upsert('B', '0x' + 'b'.repeat(40));
  const clan = clans.create('r', 'A', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  clans.join(clan.id, 'B', { enabled: true, balancePercentCap: 50, maxUsdPerTrade: 1000 });
  engine = new MirrorEngine({ optOutSeconds: 0.05, minMirrorAusd: 1 }, { sessionFor: async () => { throw new Error('none'); }, venue: () => venue as any, nadWatcher: null });
});

test('transient failures before sending are retried and the mirror opens', async () => {
  mode = 'flaky-then-ok'; balanceCalls = 0; openCalls = 0;
  const m = await leaderTrade('16');
  await wait(600);
  const after = mirrors.get(m.id);
  assert.equal(after.status, 'open');
  assert.equal(balanceCalls, 3, 'failed twice, third try sized it');
  assert.equal(openCalls, 1, 'exactly one order');
});

test('a failure after the order left is never retried (no double position)', async () => {
  mode = 'fail-after-send'; balanceCalls = 0; openCalls = 0;
  const m = await leaderTrade('32');
  await wait(600);
  const after = mirrors.get(m.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /failed after sending, not retried/);
  assert.equal(openCalls, 1);
});

test('retries give up after the limit', async () => {
  mode = 'always-fail-before-send'; balanceCalls = 0; openCalls = 0;
  const m = await leaderTrade('48');
  await wait(800);
  const after = mirrors.get(m.id);
  assert.equal(after.status, 'failed');
  assert.equal(balanceCalls, 3, '1 try + 2 retries');
  assert.equal(openCalls, 0);
});
