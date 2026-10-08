import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { PermissionDeniedError } from '@privy-io/node';
import type { MarginDeps } from '../src/funding/margin.js';
import type { TradingSession } from '../src/perpl/session.js';
import type { Account } from '../src/perpl/types.js';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET = '00'.repeat(32);
process.env.PERPL_CHAIN_ID = '10143';
process.env.NADFUN_GAS_RESERVE_MON = '0.25';
process.env.TOPUP_GAS_MON = '0.1';

let margin: typeof import('../src/funding/margin.js');
let members: typeof import('../src/store/members.js')['members'];
let Session: typeof import('../src/perpl/session.js')['TradingSession'];
let nextMember = 0;
const raw = (dollars: number) => ethers.parseUnits(String(dollars), 6);

before(async () => {
  margin = await import('../src/funding/margin.js');
  ({ members } = await import('../src/store/members.js'));
  ({ TradingSession: Session } = await import('../src/perpl/session.js'));
});

function fixture(options: { chainId?: number; free?: number; wallet?: number; mon?: number; cap?: number; credit?: boolean } = {}) {
  const n = ++nextMember;
  const userId = `funding-${n}`;
  const walletAddress = `0x${n.toString(16).padStart(40, '0')}`;
  members.upsert(userId, walletAddress);
  members.setAccount(userId, n);
  members.setPrivyPolicy(userId, 'offline-policy', raw(options.cap ?? 1000), 'offline-rules');
  const session: TradingSession = new Session({ apiKey: 'offline-key', secret: new Uint8Array(32) });
  const account: Account = { in: 1, id: n, fr: false, fw: true, ft: 0, lfr: 0, b: raw(options.free ?? 0).toString(), lb: '0' };
  session.accounts.set(n, account);
  let wallet = raw(options.wallet ?? 949.87);
  let mon = options.mon ?? 0.5;
  const deposits: bigint[] = [];
  const calls = { collateral: 0, gas: 0, signer: 0, native: 0, price: 0, usdc: 0, convert: 0, swaps: 0, orders: 0 };
  const signer = { address: walletAddress, signTypedData: async () => { throw new Error('unexpected signing'); }, sendTransaction: async () => { throw new Error('unexpected broadcast'); } };
  session.placeOrder = async () => { calls.orders++; throw new Error('unexpected order'); };
  const deps: MarginDeps = {
    chainId: options.chainId ?? 10143,
    exchangeInfo: async () => ({ exchange: walletAddress, collateralToken: walletAddress, collateralDecimals: 6, minDeposit: raw(10), minAccountOpen: raw(100) }),
    session: async () => session,
    signer: () => { calls.signer++; return signer; },
    collateral: async () => { calls.collateral++; return wallet; },
    nativeBalance: async () => { calls.native++; return ethers.parseEther(String(mon)); },
    monPrice: async () => { calls.price++; return 0.02711; },
    usdcBalance: async () => { calls.usdc++; return 0; },
    convertUsdc: async () => { calls.convert++; return null; },
    swap: async (_signer, _input, _output, amount) => {
      calls.swaps++;
      mon -= Number(ethers.formatEther(amount));
      wallet = raw(51.5);
      return { txHash: 'offline-swap', approveTx: null, amountIn: amount, received: wallet };
    },
    deposit: async (_signer, amount) => {
      assert.ok(amount >= raw(10), 'each deposit meets the exchange minimum');
      assert.ok(amount <= raw(options.cap ?? 1000), 'each deposit stays within policy');
      deposits.push(amount);
      wallet -= amount;
      if (options.credit !== false) {
        account.b = (BigInt(account.b) + amount).toString();
        session.emit('account', account);
      }
      return { approveTx: null, depositTx: 'offline-deposit' };
    },
    gas: async () => { calls.gas++; return { mon, topped: false, ...(mon === 0 ? { reason: 'off' as const } : {}) }; },
    creditTimeoutMs: 20,
  };
  return { userId, deps, session, account, deposits, calls, setWallet: (dollars: number) => { wallet = raw(dollars); } };
}

test('testnet spendable margin excludes MON and USDC without requesting a mainnet quote', async () => {
  const f = fixture({ wallet: 0, mon: 35_037 });
  assert.equal(await margin.walletSpendableAusd(f.userId, f.deps), 0);
  assert.equal(f.calls.native + f.calls.price + f.calls.usdc + f.calls.swaps, 0);
});

test('testnet MON cannot fund the $50 margin / 10x trade', async () => {
  const f = fixture({ wallet: 0, mon: 35_037 });
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), (e: Error) => e instanceof margin.FundsError && /testnet dollars/.test(e.message));
  assert.equal(f.calls.convert + f.calls.swaps + f.calls.signer + f.calls.orders, 0);
  assert.deepEqual(f.deposits, []);
});

test('testnet wallet dollars fund the $50 margin / 10x trade without a swap', async () => {
  const f = fixture();
  assert.deepEqual(await margin.ensurePerplMargin(f.userId, 51.5, f.deps), { depositedAusd: 51.5, monSwapped: 0 });
  assert.deepEqual(f.deposits, [raw(51.5)]);
  assert.equal(f.calls.convert + f.calls.swaps + f.calls.native + f.calls.price, 0);
});

test('enough existing margin needs neither a wallet transaction nor MON for gas', async () => {
  const f = fixture({ free: 100, wallet: 0, mon: 0 });
  assert.deepEqual(await margin.ensurePerplMargin(f.userId, 51.5, f.deps), { depositedAusd: 0, monSwapped: 0 });
  assert.equal(f.calls.collateral + f.calls.gas + f.calls.signer, 0);
});

test('dollars with zero MON and disabled top-up fail before signing or deposit', async () => {
  const f = fixture({ mon: 0 });
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), (e: Error) => e instanceof margin.FundsError && /MON for network fees/.test(e.message));
  assert.equal(f.calls.gas, 1);
  assert.equal(f.calls.signer + f.calls.orders, 0);
  assert.deepEqual(f.deposits, []);
});

test('a successful gas top-up allows the collateral deposit', async () => {
  const f = fixture({ mon: 0 });
  f.deps.gas = async () => ({ mon: 0.5, topped: true });
  await margin.ensurePerplMargin(f.userId, 51.5, f.deps);
  assert.deepEqual(f.deposits, [raw(51.5)]);
});

test('small shortfalls deposit the exchange minimum', async () => {
  const f = fixture({ free: 50 });
  assert.equal((await margin.ensurePerplMargin(f.userId, 51.5, f.deps)).depositedAusd, 10);
  assert.deepEqual(f.deposits, [raw(10)]);
});

test('policy-sized pieces never leave a final deposit below the minimum', async () => {
  const f = fixture({ cap: 100 });
  await margin.ensurePerplMargin(f.userId, 105, f.deps);
  assert.deepEqual(f.deposits, [raw(95), raw(10)]);
});

test('an impossible deposit split fails before moving funds', async () => {
  const f = fixture({ cap: 10 });
  await assert.rejects(margin.ensurePerplMargin(f.userId, 15, f.deps), margin.FundsError);
  assert.equal(f.calls.gas + f.calls.signer + f.calls.convert + f.calls.swaps, 0);
  assert.deepEqual(f.deposits, []);
});

test('a zero policy cap fails without looping or sending deposits', async () => {
  const f = fixture({ cap: 0 });
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), margin.FundsError);
  assert.deepEqual(f.deposits, []);
});

test('a delayed account credit resolves once sufficient free margin is confirmed', async () => {
  const f = fixture({ credit: false });
  f.deps.creditTimeoutMs = 1000;
  const deposit = f.deps.deposit;
  f.deps.deposit = async (signer, amount) => {
    const result = await deposit(signer, amount);
    setImmediate(() => {
      f.session.emit('account', { ...f.account, id: -1, b: amount.toString() });
      assert.equal(f.session.listenerCount('account'), 1);
      f.account.b = amount.toString();
      f.session.emit('account', f.account);
    });
    return result;
  };
  await margin.ensurePerplMargin(f.userId, 51.5, f.deps);
  assert.equal(f.session.listenerCount('account'), 0);
});

test('unconfirmed deposits stop the trade on timeout and remove the account listener', async () => {
  const f = fixture({ credit: false });
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), (e: Error) => e instanceof margin.FundsError && /No order was sent/.test(e.message));
  assert.deepEqual(f.deposits, [raw(51.5)]);
  assert.equal(f.calls.orders, 0);
  assert.equal(f.session.listenerCount('account'), 0);
});

test('credited but locked collateral is not treated as available margin', async () => {
  const f = fixture();
  f.account.lb = raw(50).toString();
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), margin.FundsError);
  assert.equal(f.calls.orders, 0);
  assert.equal(f.session.listenerCount('account'), 0);
});

test('mainnet MON conversion still funds margin and preserves the gas reserve', async () => {
  const f = fixture({ chainId: 143, wallet: 0, mon: 2100 });
  const result = await margin.ensurePerplMargin(f.userId, 51.5, f.deps);
  assert.equal(result.depositedAusd, 51.5);
  assert.ok(result.monSwapped > 0 && result.monSwapped < 2099.65);
  assert.equal(f.calls.convert, 1);
  assert.equal(f.calls.swaps, 1);
});

test('mainnet spendable margin continues to include convertible USDC and spare MON', async () => {
  const f = fixture({ chainId: 143, wallet: 20, mon: 100 });
  f.deps.usdcBalance = async () => 30;
  const balance = await margin.walletSpendableAusd(f.userId, f.deps);
  assert.ok(Math.abs(balance - (50 + 99.65 * 0.02711 * 0.97)) < 1e-9);
});

test('nonzero MON that cannot pay the transaction fee preserves the structured gas error without retrying', async () => {
  const f = fixture({ mon: 0.000001 });
  const error = Object.assign(new Error('transaction cannot be paid'), { code: 'INSUFFICIENT_FUNDS' });
  let attempts = 0;
  f.deps.deposit = async () => { attempts++; throw error; };
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), (e) => e === error);
  assert.equal(attempts, 1);
  assert.equal(f.calls.orders, 0);
});

test('an untyped funding error remains visible and is not retried', async () => {
  const f = fixture();
  const error = Object.assign(new Error('403 transaction violates policy'), { status: 403 });
  let attempts = 0;
  f.deps.deposit = async () => { attempts++; throw error; };
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), (e) => e === error);
  assert.equal(attempts, 1);
  assert.equal(f.calls.orders, 0);
});

test('a typed Privy signing refusal becomes an actionable funding error with its cause', async () => {
  const f = fixture();
  const error = new PermissionDeniedError(403, { message: 'transaction violates policy' }, undefined, new Headers());
  let attempts = 0;
  f.deps.deposit = async () => { attempts++; throw error; };
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), (e: Error) => e instanceof margin.FundsError && e.cause === error && /Renew trading permission/.test(e.message));
  assert.equal(attempts, 1);
  assert.equal(f.calls.orders, 0);
});

test('an unknown broadcast outcome is preserved without a misleading not-sent claim or retry', async () => {
  const f = fixture();
  const error = new Error('receipt missing after broadcast');
  let attempts = 0;
  f.deps.deposit = async () => { attempts++; throw error; };
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), (e) => e === error);
  assert.equal(attempts, 1);
});

test('mainnet USDC conversion covers the shortfall without spending MON on a swap', async () => {
  const f = fixture({ chainId: 143, wallet: 0 });
  f.deps.convertUsdc = async () => { f.calls.convert++; f.setWallet(60); return { ausd: 60 }; };
  await margin.ensurePerplMargin(f.userId, 51.5, f.deps);
  assert.equal(f.calls.convert, 1);
  assert.equal(f.calls.swaps, 0);
  assert.deepEqual(f.deposits, [raw(51.5)]);
});

test('swap slippage below the needed margin stops before depositing or placing an order', async () => {
  const f = fixture({ chainId: 143, wallet: 0, mon: 2100 });
  f.deps.swap = async (_signer, _input, _output, amount) => {
    f.calls.swaps++;
    f.setWallet(51);
    return { txHash: 'offline-swap', approveTx: null, amountIn: amount, received: raw(51) };
  };
  await assert.rejects(margin.ensurePerplMargin(f.userId, 51.5, f.deps), (e: Error) => e instanceof margin.FundsError && /less than needed/.test(e.message));
  assert.equal(f.calls.swaps, 1);
  assert.equal(f.calls.orders, 0);
  assert.deepEqual(f.deposits, []);
});

test('swap proceeds below the minimum deposit stay in the wallet even if they cover the requested shortfall', async () => {
  const f = fixture({ chainId: 143, wallet: 0, mon: 2100 });
  f.deps.swap = async (_signer, _input, _output, amount) => {
    f.calls.swaps++;
    f.setWallet(7);
    return { txHash: 'offline-swap', approveTx: null, amountIn: amount, received: raw(7) };
  };
  await assert.rejects(margin.ensurePerplMargin(f.userId, 5, f.deps), margin.FundsError);
  assert.equal(f.calls.swaps, 1);
  assert.deepEqual(f.deposits, []);
});

test('micro-dollar rounding splits a cap-adjacent amount into valid deposits', async () => {
  const f = fixture({ cap: 100 });
  const result = await margin.ensurePerplMargin(f.userId, 100.0000001, f.deps);
  assert.equal(result.depositedAusd, 100.000001);
  assert.deepEqual(f.deposits, [raw(90.000001), raw(10)]);
});
