import { ethers } from 'ethers';
import { PermissionDeniedError } from '@privy-io/node';
import { env, numEnv } from '../config/env.js';
import { sessionFor } from '../accounts/lifecycle.js';
import { signerFor } from '../accounts/signers.js';
import { collateralBalance, depositCollateral } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import type { TradingSession } from '../perpl/session.js';
import { getExchangeInfo } from '../perpl/context.js';
import { members } from '../store/members.js';
import { monPriceAusd } from '../prices.js';
import { NATIVE, swap } from '../swap/kuruFlow.js';
import { GAS_RESERVE_WEI } from '../venues/nadfun.js';
import { FundsError, FundingAuthorizationError } from './errors.js';
import { ensureGas } from './gas.js';

// Perps paid from whatever the member holds. Before a Perpl order the member's
// Perpl account is topped up to cover its margin: from AUSD in the wallet
// first, then from MON swapped to AUSD on Kuru Flow. The gas reserve is never
// touched. Everything is signed under the member's Privy policy (Kuru MON->AUSD
// paying the member, AUSD approve + deposit into their own Perpl account, each
// capped), so manual trades and Auto-follow copies are funded the same way.

export { FundsError };

// Gas for the swap, approve and deposit, on top of the reserve (Monad charges
// the whole gas limit).
const TOPUP_GAS_WEI = ethers.parseEther(String(numEnv('TOPUP_GAS_MON', 0.1)));
// MON counts at 97% of its price when sizing: swap slippage and price moves.
const MON_HAIRCUT = 0.97;
const SWAP_SLIPPAGE_BPS = 100;

export interface MarginDeps {
  chainId: number;
  exchangeInfo: typeof getExchangeInfo;
  session: typeof sessionFor;
  signer: typeof signerFor;
  collateral: typeof collateralBalance;
  nativeBalance(wallet: string): Promise<bigint>;
  monPrice: typeof monPriceAusd;
  usdcBalance(wallet: string): Promise<number>;
  convertUsdc(userId: string): Promise<unknown>;
  swap: typeof swap;
  deposit: typeof depositCollateral;
  gas: typeof ensureGas;
  creditTimeoutMs?: number;
}

const defaultDeps: MarginDeps = {
  chainId: env.chainId,
  exchangeInfo: getExchangeInfo,
  session: sessionFor,
  signer: signerFor,
  collateral: collateralBalance,
  nativeBalance: (wallet) => rpc().getBalance(wallet),
  monPrice: monPriceAusd,
  usdcBalance: async (wallet) => (await import('./usdc.js')).usdcUsd(wallet),
  convertUsdc: async (userId) => (await import('./usdc.js')).convertUsdcNow(userId),
  swap,
  deposit: depositCollateral,
  gas: ensureGas,
};

function accountId(userId: string): number {
  const id = members.get(userId)?.perplAccountId;
  if (!id) throw new FundsError('Set up perps first: your Perpl account is opened from the app');
  return id;
}

function freeRaw(session: TradingSession, id: number): bigint {
  const a = session.accounts.get(id);
  if (!a) throw new Error(`Perpl session has no account ${id}`);
  const free = BigInt(a.b) - BigInt(a.lb);
  return free > 0n ? free : 0n;
}

// $ free in the member's Perpl account.
export async function perplFreeAusd(userId: string): Promise<number> {
  const { collateralDecimals } = await getExchangeInfo();
  return Number(freeRaw(await sessionFor(userId), accountId(userId))) / 10 ** collateralDecimals;
}

// $ the member could move into Perpl right now: AUSD in the wallet plus MON
// above the gas reserve (at a small haircut).
export async function walletSpendableAusd(userId: string, deps: MarginDeps = defaultDeps): Promise<number> {
  const m = members.get(userId);
  if (!m) return 0;
  const { collateralDecimals } = await deps.exchangeInfo();
  // Kuru converts MON and USDC only on mainnet; testnet margin uses AUSD.
  if (deps.chainId !== 143) return Number(await deps.collateral(m.wallet)) / 10 ** collateralDecimals;
  const [ausd, mon, px, usdc] = await Promise.all([deps.collateral(m.wallet), deps.nativeBalance(m.wallet), deps.monPrice().catch(() => 0), deps.usdcBalance(m.wallet)]);
  const spareMon = mon - GAS_RESERVE_WEI - TOPUP_GAS_WEI;
  const monUsd = spareMon > 0n ? Number(ethers.formatEther(spareMon)) * px * MON_HAIRCUT : 0;
  // USDC is converted to AUSD when a trade needs it (ensurePerplMargin).
  return Number(ausd) / 10 ** collateralDecimals + usdc + monUsd;
}

// Make sure the Perpl account has at least `needAusd` free. Returns what was
// moved in (0 if it already had enough).
export async function ensurePerplMargin(userId: string, needAusd: number, deps: MarginDeps = defaultDeps): Promise<{ depositedAusd: number; monSwapped: number }> {
  const id = accountId(userId);
  const m = members.get(userId)!;
  const session = await deps.session(userId);
  const { collateralDecimals, minDeposit, collateralToken } = await deps.exchangeInfo();
  const unit = 10 ** collateralDecimals;
  const needRaw = BigInt(Math.ceil(needAusd * unit));
  const free = freeRaw(session, id);
  if (free >= needRaw) return { depositedAusd: 0, monSwapped: 0 };

  let deposit = needRaw - free;
  if (deposit < minDeposit) deposit = minDeposit;
  const policy = members.privyPolicy(userId);
  if (!policy) throw new FundsError('Allow Cult to fund your trades first (approve the trading signer in the app)');

  if (policy.capRaw < minDeposit || policy.capRaw <= 0n) throw new FundsError('Approve a trading funding limit that covers the minimum Perpl deposit. No margin deposit was sent.');
  const minimumPieces = (deposit + policy.capRaw - 1n) / policy.capRaw;
  if (deposit < minimumPieces * minDeposit) throw new FundsError('This margin top-up cannot fit the funding limit and minimum Perpl deposit. Approve a higher funding limit. No margin deposit was sent.');

  let wallet = await deps.collateral(m.wallet);
  let monSwapped = 0;
  if (wallet < deposit && deps.chainId !== 143) {
    throw new FundsError(`This trade needs $${(Number(deposit) / unit).toFixed(2)} of testnet dollars in your wallet. MON pays network fees; it cannot be converted to margin on testnet.`);
  }
  const gas = await deps.gas(m.wallet);
  if (gas.mon <= 0) throw new FundsError('Top up MON for network fees before moving funds into your trading account. No order was sent.');
  const signer = deps.signer(userId);
  // Deposited USDC counts as dollars: convert it before reaching for MON.
  if (wallet < deposit) {
    if (await deps.convertUsdc(userId)) wallet = await deps.collateral(m.wallet);
  }
  if (wallet < deposit) {
    // Swap just enough MON for the rest, never touching the gas reserve.
    const px = await deps.monPrice();
    const shortUsd = Number(deposit - wallet) / unit;
    const monWei = ethers.parseEther(((shortUsd / px) * (1 + SWAP_SLIPPAGE_BPS / 10_000) * 1.01).toFixed(18));
    const spare = (await deps.nativeBalance(m.wallet)) - GAS_RESERVE_WEI - TOPUP_GAS_WEI;
    if (spare < monWei) {
      const have = Number(wallet) / unit + (spare > 0n ? Number(ethers.formatEther(spare)) * px : 0);
      throw new FundsError(`Not enough funds for this trade: it needs $${(Number(deposit) / unit).toFixed(2)} more in margin, you have about $${have.toFixed(2)} (keeping ${ethers.formatEther(GAS_RESERVE_WEI)} MON for fees)`);
    }
    await deps.swap(signer, NATIVE, collateralToken, monWei, { slippageBps: SWAP_SLIPPAGE_BPS });
    monSwapped = Number(ethers.formatEther(monWei));
    wallet = await deps.collateral(m.wallet);
    if (wallet < deposit) deposit = wallet; // slippage: move what arrived
    if (deposit < needRaw - free) throw new FundsError('The MON swap returned less than needed; try a slightly smaller trade');
  }

  // The policy caps each deposit; bigger top-ups go in a few pieces.
  let pieces = (deposit + policy.capRaw - 1n) / policy.capRaw;
  if (deposit < pieces * minDeposit) throw new FundsError('The swap returned too little for valid Perpl deposits under the funding limit. No margin deposit was sent.');
  const before = BigInt(session.accounts.get(id)?.b ?? '0');
  for (let left = deposit; left > 0n; ) {
    const available = left - (pieces - 1n) * minDeposit;
    const piece = available > policy.capRaw ? policy.capRaw : available;
    try {
      await deps.deposit(signer, piece);
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        console.warn('[margin] funding signing refused:', { stage: 'collateral deposit', status: error.status });
        throw new FundingAuthorizationError(error);
      }
      throw error;
    }
    left -= piece;
    pieces--;
  }
  await creditedBy(session, id, before + deposit, needRaw, deps.creditTimeoutMs);
  console.log(`[margin] ${m.wallet}: +$${(Number(deposit) / unit).toFixed(2)} into Perpl${monSwapped ? ` (${monSwapped} MON swapped)` : ''}`);
  return { depositedAusd: Number(deposit) / unit, monSwapped };
}

// Perpl credits a deposit once it sees the chain event; wait for the account
// update so an order is never sent against an unconfirmed deposit.
function creditedBy(session: TradingSession, id: number, balanceRaw: bigint, needRaw: bigint, timeoutMs = 20_000): Promise<void> {
  const credited = () => BigInt(session.accounts.get(id)?.b ?? '0') >= balanceRaw && freeRaw(session, id) >= needRaw;
  if (credited()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      session.off('account', onAccount);
    };
    const onAccount = (a: { id: number; b: string }) => {
      if (a.id === id && credited()) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new FundsError('Funds were deposited, but Perpl has not confirmed enough free margin yet. No order was sent. Wait for your trading balance to update before trying again.'));
    }, timeoutMs);
    session.on('account', onAccount);
  });
}
