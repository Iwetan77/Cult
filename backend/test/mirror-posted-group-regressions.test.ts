import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { MirrorPolicy } from '../src/store/clans.js';
import type { Fill, OpenInput, CloseInput } from '../src/venues/types.js';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET = '00'.repeat(32);
process.env.PERPL_CHAIN_ID = '10143';
process.env.PRIVY_APP_ID = 'offline-app';
process.env.PRIVY_APP_SECRET = 'offline-secret';
process.env.PRIVY_BACKEND_KEY_QUORUM_ID = 'offline-signer';

let Engine: typeof import('../src/mirror/engine.js')['MirrorEngine'];
let Session: typeof import('../src/perpl/session.js')['TradingSession'];
let clans: typeof import('../src/store/clans.js')['clans'];
let members: typeof import('../src/store/members.js')['members'];
let repo: typeof import('../src/mirror/repo.js');
let audience: typeof import('../src/mirror/audience.js');
let origin: typeof import('../src/mirror/origin.js');
const on: MirrorPolicy = { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 40 };
const off: MirrorPolicy = { ...on, enabled: false };
const opens: OpenInput[] = [];
const closes: CloseInput[] = [];
const balanceReads: string[] = [];
const balances = new Map<string, number>();
const engines: InstanceType<typeof Engine>[] = [];
let next = 0;
let requestId = 0;

before(async () => {
  // Every venue operation is replaced; accidental network access fails the test.
  mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network access'); });
  ({ MirrorEngine: Engine } = await import('../src/mirror/engine.js'));
  ({ TradingSession: Session } = await import('../src/perpl/session.js'));
  ({ clans } = await import('../src/store/clans.js'));
  ({ members } = await import('../src/store/members.js'));
  repo = await import('../src/mirror/repo.js');
  audience = await import('../src/mirror/audience.js');
  origin = await import('../src/mirror/origin.js');
  const { getDb } = await import('../src/store/db.js');
  const databases = getDb().prepare('PRAGMA database_list').all() as { file: string }[];
  assert.ok(databases.every(db => db.file === ''), 'only in-memory SQLite is used');
  const { perpl } = await import('../src/venues/perpl.js');
  mock.method(perpl, 'maxLeverage', async () => 10);
  mock.method(perpl, 'markPriceAusd', async () => 1);
  mock.method(perpl, 'freeBalanceAusd', async (userId: string) => {
    balanceReads.push(userId);
    return balances.get(userId) ?? 1000;
  });
  mock.method(perpl, 'holdings', async (_userId: string, markets: string[] = []) => markets.map(market => ({
    venue: 'perpl' as const, market, symbol: 'TEST', side: 'long' as const,
    sizeRaw: '100', size: 100, entryPriceAusd: 1, markPriceAusd: 1,
    valueAusd: 100, pnlAusd: 0, leverage: 5,
  })));
  mock.method(perpl, 'open', async (input: OpenInput): Promise<Fill> => {
    opens.push(input);
    input.onRef?.({ rq: ++requestId, accountId: members.get(input.userId)!.perplAccountId! });
    return { venue: 'perpl', market: input.market, side: input.side, sizeRaw: '100', size: 100,
      priceAusd: 1, notionalAusd: input.notionalAusd, orderId: requestId };
  });
  mock.method(perpl, 'close', async (input: CloseInput): Promise<Fill> => {
    closes.push(input);
    return { venue: 'perpl', market: input.market, side: 'long', sizeRaw: input.sizeRaw ?? '100',
      size: 100, priceAusd: 1, notionalAusd: 100, orderId: ++requestId };
  });
});

after(() => {
  for (const engine of engines) engine.stop();
  mock.restoreAll();
});

function ready(userId: string, step: 'account' | 'key' | 'forwarding' | 'ready' = 'ready') {
  if (step === 'account') return;
  members.setAccount(userId, ++next);
  if (step === 'key') return;
  members.setApiKey(userId, 'offline-key', new Uint8Array(32), 'offline-pubkey');
  if (step === 'forwarding') return;
  members.setForwarding(userId, true);
}

function fixture(step: Parameters<typeof ready>[1] = 'ready') {
  const leader = `posted-leader-${++next}`;
  const follower = `posted-follower-${++next}`;
  for (const userId of [leader, follower]) {
    members.upsert(userId, `0x${(++next).toString(16).padStart(40, '0')}`);
  }
  ready(leader);
  ready(follower, step);
  const clanId = clans.create('posted group', leader, off).id;
  clans.join(clanId, follower, on);
  // Use the engine's production eligibility checks with mocked venue methods.
  const engine = new Engine({ optOutSeconds: 60 }, {
    sessionFor: async () => { throw new Error('unexpected session'); }, nadWatcher: null,
  });
  engines.push(engine);
  const open = () => engine.leaderOpened({ venue: 'perpl', userId: leader, market: '16', side: 'long',
    sizeRaw: '100', entryPriceAusd: 1, leverageHundredths: 500, marginFraction: 0.5 });
  return { engine, leader, follower, clanId, open };
}

test('a disabled shared group does not suppress a follower opted into another posted group', async () => {
  const f = fixture();
  clans.setPolicy(f.clanId, f.follower, off);
  const enabledGroup = clans.create('enabled group', f.leader, off).id;
  clans.join(enabledGroup, f.follower, on);
  audience.setAudience(f.leader, 'perpl', '16', [f.clanId, enabledGroup]);
  const trade = (await f.open())!;
  assert.deepEqual(trade.cultIds, [f.clanId, enabledGroup]);
  const deliveries = repo.mirrors.forTrade(trade.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].clanId, enabledGroup);
  await f.engine.fire(deliveries[0].id);
  const mirror = repo.mirrors.get(deliveries[0].id)!;
  assert.equal(mirror.status, 'open');
  assert.equal(mirror.notionalUsd, 40);
  assert.equal(mirror.marginUsd, 8);
  assert.match(mirror.capApplied!, /balance_percent_cap/);
  assert.match(mirror.capApplied!, /max_usd_per_trade/);
});

test('multiple enabled posted groups deliver only one copy per follower', async () => {
  const f = fixture();
  const other = clans.create('other group', f.leader, off).id;
  clans.join(other, f.follower, on);
  const trade = (await f.open())!;
  assert.equal(repo.mirrors.forTrade(trade.id).length, 1);
});

test('posting only to a disabled group does not use consent from an unposted group', async () => {
  const f = fixture();
  clans.setPolicy(f.clanId, f.follower, off);
  const other = clans.create('unposted group', f.leader, off).id;
  clans.join(other, f.follower, on);
  audience.setAudience(f.leader, 'perpl', '16', [f.clanId]);
  const trade = (await f.open())!;
  assert.deepEqual(trade.cultIds, [f.clanId]);
  assert.deepEqual(repo.mirrors.forTrade(trade.id), []);
  audience.setAudience(f.leader, 'perpl', '16', []);
  assert.equal(await f.open(), null);
});

test('posting a trade does not promote an ordinary member to group leader', async () => {
  const f = fixture();
  audience.setAudience(f.follower, 'perpl', '16', [f.clanId]);
  assert.equal(await f.engine.leaderOpened({ venue: 'perpl', userId: f.follower, market: '16', side: 'long',
    sizeRaw: '100', entryPriceAusd: 1, leverageHundredths: 500, marginFraction: 0.1 }), null);
});

test('each missing Perpl setup step creates a cancelled delivery with the specific reason', async t => {
  for (const [step, reason] of [['account', /create your Perpl account/], ['key', /enroll your trading key/],
    ['forwarding', /enable order forwarding/]] as const) {
    await t.test(step, async () => {
      const f = fixture(step);
      const trade = (await f.open())!;
      const mirror = repo.mirrors.forTrade(trade.id)[0];
      assert.equal(mirror.status, 'cancelled');
      assert.match(mirror.error!, reason);
      assert.ok(!opens.some(input => input.userId === f.follower));
    });
  }
});

test('Nad.fun followers without a real wallet signer are cancelled with a reason', async () => {
  const f = fixture();
  const trade = (await f.engine.leaderOpened({ venue: 'nadfun', userId: f.leader, market: `0x${'a'.repeat(40)}`,
    side: 'buy', sizeRaw: '100', entryPriceAusd: 1, leverageHundredths: 100, marginFraction: 0.1 }))!;
  const mirror = repo.mirrors.forTrade(trade.id)[0];
  assert.equal(mirror.status, 'cancelled');
  assert.equal(mirror.error, 'no Privy wallet on file');
});

test('Nad.fun eligibility checks attached signer and current policy, not just an issued grant', async t => {
  for (const [policyIds, reason] of [[null, /signer not added/], [['old-policy'], /outdated policy/]] as const) {
    await t.test(policyIds === null ? 'unattached' : 'outdated', async () => {
      const f = fixture();
      members.upsert(f.follower, members.get(f.follower)!.wallet, `offline-wallet-${f.follower}`);
      members.setPrivyPolicy(f.follower, 'current-policy', 40_000_000n, 'offline-rules');
      const fetchMock = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
        assert.equal(String(url), `https://api.privy.io/v1/wallets/offline-wallet-${f.follower}`);
        return new Response(JSON.stringify({ additional_signers: policyIds === null ? [] : [
          { signer_id: 'offline-signer', override_policy_ids: policyIds },
        ] }), { headers: { 'content-type': 'application/json' } });
      });
      try {
        const trade = (await f.engine.leaderOpened({ venue: 'nadfun', userId: f.leader,
          market: `0x${'b'.repeat(40)}`, side: 'buy', sizeRaw: '100', entryPriceAusd: 1,
          leverageHundredths: 100, marginFraction: 0.1 }))!;
        const mirror = repo.mirrors.forTrade(trade.id)[0];
        assert.equal(mirror.status, 'cancelled');
        assert.match(mirror.error!, reason);
      } finally {
        fetchMock.mock.restore();
      }
    });
  }
});

test('forwarding revoked during the skip window cancels without balance reads or orders', async () => {
  const f = fixture();
  const trade = (await f.open())!;
  const pending = repo.mirrors.forTrade(trade.id)[0];
  members.setForwarding(f.follower, false);
  await f.engine.fire(pending.id);
  const mirror = repo.mirrors.get(pending.id)!;
  assert.equal(mirror.status, 'cancelled');
  assert.match(mirror.error!, /enable order forwarding/);
  assert.ok(!balanceReads.includes(f.follower));
  assert.ok(!opens.some(input => input.userId === f.follower));
});

test('copying disabled during the skip window sends no orders', async () => {
  const f = fixture();
  const trade = (await f.open())!;
  const pending = repo.mirrors.forTrade(trade.id)[0];
  clans.setPolicy(f.clanId, f.follower, off);
  await f.engine.fire(pending.id);
  assert.equal(repo.mirrors.get(pending.id)!.status, 'failed');
  assert.match(repo.mirrors.get(pending.id)!.error!, /disabled by the member/);
  assert.ok(!balanceReads.includes(f.follower));
  assert.ok(!opens.some(input => input.userId === f.follower));
});

test('a pending add rechecks forwarding, while existing copies still reduce after opt-out', async () => {
  const f = fixture();
  const trade = (await f.open())!;
  const mirror = repo.mirrors.forTrade(trade.id)[0];
  await f.engine.fire(mirror.id);
  await f.engine.leaderResized(trade, 200n, 1);
  const add = repo.adjustments.forMirror(mirror.id)[0];
  members.setForwarding(f.follower, false);
  await (f.engine as any).runAdjustment(add.id);
  assert.equal(repo.adjustments.get(add.id)!.status, 'cancelled');
  assert.match(repo.adjustments.get(add.id)!.error!, /enable order forwarding/);
  assert.equal(opens.filter(input => input.userId === f.follower).length, 1);
  members.setForwarding(f.follower, true);
  clans.setPolicy(f.clanId, f.follower, off);
  await f.engine.leaderResized(repo.trades.get(trade.id)!, 100n, 1);
  const reduce = repo.adjustments.forMirror(mirror.id).find(a => a.kind === 'reduce')!;
  await (f.engine as any).runAdjustment(reduce.id);
  assert.equal(repo.adjustments.get(reduce.id)!.status, 'done');
  assert.equal(closes.find(input => input.userId === f.follower)!.sizeRaw, '50');
});

test('no spendable balance and dust sizing produce failed deliveries without an order', async () => {
  for (const balance of [0, 0.1]) {
    const f = fixture();
    balances.set(f.follower, balance);
    const trade = (await f.open())!;
    const mirror = repo.mirrors.forTrade(trade.id)[0];
    await f.engine.fire(mirror.id);
    const failed = repo.mirrors.get(mirror.id)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, balance === 0 ? /no free balance/ : /minimum/);
    assert.ok(!opens.some(input => input.userId === f.follower));
  }
});

test('an untagged app-origin Perpl position event records the selected audience; copies are ignored', async () => {
  const f = fixture();
  const accountId = members.get(f.leader)!.perplAccountId!;
  const session = new Session({ apiKey: 'offline-key', secret: new Uint8Array(32) });
  session.accounts.set(accountId, { id: accountId, b: '900000000', lb: '0' } as any);
  const engine = new Engine({ optOutSeconds: 60 }, { sessionFor: async () => session, nadWatcher: null });
  engines.push(engine);
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.match(String(url), /\/v1\/pub\/context$/);
    return new Response(JSON.stringify({
      instances: [{ address: '0x1', collateral_token_id: 1, min_account_open_amount: '100000000', min_deposit_amount: '10000000' }],
      tokens: [{ id: 1, address: '0x2', decimals: 6 }],
      markets: [{ id: 16, symbol: 'TEST', config: { price_decimals: 0 } }],
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    await engine.watch(f.leader);
    audience.setAudience(f.leader, 'perpl', '16', [f.clanId]);
    const detected = once(engine, 'trade', { signal: AbortSignal.timeout(1000) });
    const position = { acc: accountId, pid: 100, mkt: 16, rq: 10000, sr: 21, sd: 1, s: 100,
      ep: 1, lv: 500, c: '100000000' };
    session.emit('position', position as any);
    const [trade] = await detected;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(trade.cultIds, [f.clanId]);
    assert.equal(trade.marginFraction, 0.1);
    assert.equal(repo.mirrors.forTrade(trade.id).length, 1);
    origin.recordRef({ rq: 10001, accountId }, 'mirror_open', 'offline-copy');
    session.emit('position', { ...position, pid: 101, rq: 10001 } as any);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(repo.trades.byPosition(accountId, 101), null);
  } finally {
    fetchMock.mock.restore();
  }
});
