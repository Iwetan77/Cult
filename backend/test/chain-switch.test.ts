// Moving the backend to another chain (testnet -> mainnet) resets trading state
// and keeps the people. And the signer policy's USDC rules exist only where
// there's USDC.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

let db: typeof import('../src/store/db.js');
let members: typeof import('../src/store/members.js')['members'];
let clans: typeof import('../src/store/clans.js')['clans'];
let cult = '';

before(async () => {
  db = await import('../src/store/db.js');
  ({ members } = await import('../src/store/members.js'));
  ({ clans } = await import('../src/store/clans.js'));
  const chat = await import('../src/api/chat.js');
  for (const u of ['A', 'B']) members.upsert(u, `0x${u.repeat(40).toLowerCase()}`, `wallet-${u}`);
  members.setUsername('A', 'alice');
  members.setAccount('A', 42);
  members.setForwarding('A', true);
  members.setPrivyPolicy('A', 'pol-1', 1_000_000_000n, 'old rules');
  cult = clans.create('cult', 'A', { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 50 }).id;
  chat.postMessage(chat.cultRoom(cult), 'A', { body: 'gm' });
  const d = db.getDb();
  d.prepare(`INSERT INTO leader_trades (id, venue, user_id, market, side, size, leverage, margin_fraction, opened_at)
             VALUES ('t1', 'perpl', 'A', '16', 'long', '100', 100, 0.1, 1)`).run();
  d.prepare(`INSERT INTO mirrors (id, trade_id, clan_id, user_id, status, skip_until, created_at, updated_at)
             VALUES ('m1', 't1', ?, 'B', 'open', 0, 1, 1)`).run(cult);
  d.prepare(`INSERT INTO cursors (name, value) VALUES ('nadfun', 66000000)`).run();
});

const count = (table: string) => (db.getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test('same chain: nothing is reset', () => {
  assert.equal(db.switchChain(db.getDb(), 10143), false, 'a database from before tracking counts as testnet');
  assert.equal(count('leader_trades'), 1);
  assert.equal(members.get('A')!.perplAccountId, 42);
});

test('testnet -> mainnet: trading state reset, people kept, Auto-follow off', () => {
  assert.equal(db.switchChain(db.getDb(), 143), true);
  // reset
  for (const t of ['leader_trades', 'mirrors', 'cursors']) assert.equal(count(t), 0, `${t} cleared`);
  const a = members.get('A')!;
  assert.equal(a.perplAccountId, null);
  assert.equal(members.credentials('A'), null);
  assert.equal(members.privyPolicy('A'), null, 'signer policies are chain-pinned: re-issued on the new chain');
  assert.equal(clans.membership(cult, 'A')!.policy.enabled, false, 'nobody copies with real money until they opt in again');
  // kept
  assert.equal(count('members'), 2);
  assert.equal(a.username, 'alice');
  assert.equal(a.privyWalletId, 'wallet-A');
  assert.equal(clans.forUser('A').length, 1);
  assert.equal(count('chat_messages') > 0, true);
  // and only once
  assert.equal(db.switchChain(db.getDb(), 143), false);
});

test('USDC rules only where there is USDC, pinned to USDC in and AUSD out', async () => {
  const { buildBackendPolicy } = await import('../src/privy/policy.js');
  const base = {
    member: '0x' + 'a'.repeat(40),
    chainId: 143,
    perplExchange: '0x' + 'e'.repeat(40),
    perplCollateral: '0x' + 'c'.repeat(40),
    maxDepositRaw: 1_000_000_000n,
    nadRouter: '0x' + 'd'.repeat(40),
    maxBuyWei: 10n ** 18n,
    kuruRouter: '0x' + 'b'.repeat(40),
    maxSellWei: 10n ** 19n,
  };
  const names = (p: ReturnType<typeof buildBackendPolicy>) => p.rules.map((r) => r.name);
  assert.equal(names(buildBackendPolicy(base)).some((n) => n.includes('USDC')), false);
  const usdc = '0x' + 'f'.repeat(40);
  const withUsdc = buildBackendPolicy({ ...base, usdc });
  const swap = withUsdc.rules.find((r) => r.name === 'sign: Kuru USDC->AUSD, capped, no fees')!;
  const cond = (field: string) => (swap.conditions as { field: string; value: string }[]).find((c) => c.field === field)?.value;
  assert.equal(cond('executeSwap.swapIntent.tokenUserSells'), usdc);
  assert.equal(cond('executeSwap.swapIntent.tokenUserBuys'), base.perplCollateral);
  assert.equal(cond('executeSwap.swapIntent.amountUserSells'), '1000000000');
  assert.ok(names(withUsdc).includes('send: approve USDC to Kuru, capped'));
});
