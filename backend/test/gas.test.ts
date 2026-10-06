// Gas top-ups: a member with dollars but no MON for fees gets a little MON
// from Cult's gas wallet; never a stranger, never an empty wallet, at most 3
// a day each, and two calls at once send once.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);
process.env.GAS_DRIP_MON = '0.5';

let ensureGas: typeof import('../src/funding/gas.js')['ensureGas'];
let GasDeps: import('../src/funding/gas.js').GasDeps;
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';

before(async () => {
  ({ ensureGas } = await import('../src/funding/gas.js'));
  const { members } = await import('../src/store/members.js');
  members.upsert('did:privy:gas-a', A);
  members.upsert('did:privy:gas-b', B);
});

// A fake chain: balances and dollars per wallet; sends credit the balance.
function chain(mon: Record<string, number>, dollars: Record<string, number>) {
  const sent: { to: string; wei: bigint }[] = [];
  const bal: Record<string, bigint> = Object.fromEntries(Object.entries(mon).map(([w, m]) => [w, ethers.parseEther(String(m))]));
  const deps: typeof GasDeps = {
    balance: async (w) => bal[w] ?? 0n,
    dollars: async (w) => dollars[w] ?? 0,
    send: async (to, wei) => { await new Promise((r) => setTimeout(r, 20)); sent.push({ to, wei }); bal[to] = (bal[to] ?? 0n) + wei; return `0x${String(sent.length).padStart(64, '0')}`; },
  };
  return { deps, sent };
}

test('a member with dollars and no MON gets topped up', async () => {
  const { deps, sent } = chain({ [A]: 0 }, { [A]: 1000 });
  const r = await ensureGas(A, deps);
  assert.equal(r.topped, true);
  assert.equal(r.mon, 0.5);
  assert.deepEqual(sent, [{ to: A, wei: ethers.parseEther('0.5') }]);
});

test('enough MON already: nothing sent', async () => {
  const { deps, sent } = chain({ [B]: 0.3 }, { [B]: 50 });
  const r = await ensureGas(B, deps);
  assert.equal(r.topped, false);
  assert.equal(sent.length, 0);
});

test('no dollars, or not a member: nothing sent', async () => {
  const { deps, sent } = chain({ [B]: 0 }, { [B]: 0.5 });
  assert.equal((await ensureGas(B, deps)).reason, 'no_funds');
  assert.equal((await ensureGas('0x00000000000000000000000000000000000000c3', deps)).reason, 'not_member');
  assert.equal(sent.length, 0);
});

test('two calls at once send once', async () => {
  const { deps, sent } = chain({ [B]: 0 }, { [B]: 20 });
  const [x, y] = await Promise.all([ensureGas(B, deps), ensureGas(B, deps)]);
  assert.equal(sent.length, 1);
  assert.equal(x.topped && y.topped, true);
});

test('at most 3 top-ups a day per member', async () => {
  // A has had 1 (first test); spend it twice more, then the limit holds.
  for (let i = 0; i < 2; i++) {
    const { deps } = chain({ [A]: 0 }, { [A]: 1000 });
    assert.equal((await ensureGas(A, deps)).topped, true);
  }
  const { deps, sent } = chain({ [A]: 0 }, { [A]: 1000 });
  assert.equal((await ensureGas(A, deps)).reason, 'limit');
  assert.equal(sent.length, 0);
  const tomorrow = Date.now() + 86_400_000 + 1;
  assert.equal((await ensureGas(A, chain({ [A]: 0 }, { [A]: 1000 }).deps, tomorrow)).topped, true);
});
