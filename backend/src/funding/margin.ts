import { ethers } from 'ethers';
import { numEnv } from '../config/env.js';
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

// Perps paid from whatever the member holds. Before a Perpl order the member's
// Perpl account is topped up to cover its margin: from AUSD in the wallet
// first, then from MON swapped to AUSD on Kuru Flow. The gas reserve is never
// touched. Everything is signed under the member's Privy policy (Kuru MON->AUSD
// paying the member, AUSD approve + deposit into their own Perpl account, each
// capped), so manual trades and Auto-follow copies are funded the same way.

export class FundsError extends Error {}

// Gas for the swap, approve and deposit, on top of the reserve (Monad charges
// the whole gas limit).
const TOPUP_GAS_WEI = ethers.parseEther(String(numEnv('TOPUP_GAS_MON', 0.1)));
// MON counts at 97% of its price when sizing: swap slippage and price moves.
const MON_HAIRCUT = 0.97;
const SWAP_SLIPPAGE_BPS = 100;

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
export async function walletSpendableAusd(userId: string): Promise<number> {
  const m = members.get(userId);
  if (!m) return 0;
  const { collateralDecimals } = await getExchangeInfo();
  const [ausd, mon, px] = await Promise.all([collateralBalance(m.wallet), rpc().getBalance(m.wallet), monPriceAusd().catch(() => 0)]);
  const spareMon = mon - GAS_RESERVE_WEI - TOPUP_GAS_WEI;
  const monUsd = spareMon > 0n ? Number(ethers.formatEther(spareMon)) * px * MON_HAIRCUT : 0;
  return Number(ausd) / 10 ** collateralDecimals + monUsd;
}

// Make sure the Perpl account has at least `needAusd` free. Returns what was
// moved in (0 if it already had enough).
export async function ensurePerplMargin(userId: string, needAusd: number): Promise<{ depositedAusd: number; monSwapped: number }> {
  const id = accountId(userId);
  const m = members.get(userId)!;
  const session = await sessionFor(userId);
  const { collateralDecimals, minDeposit } = await getExchangeInfo();
  const unit = 10 ** collateralDecimals;
  const needRaw = BigInt(Math.ceil(needAusd * unit));
  const free = freeRaw(session, id);
  if (free >= needRaw) return { depositedAusd: 0, monSwapped: 0 };

  let deposit = needRaw - free;
  if (deposit < minDeposit) deposit = minDeposit;
  const policy = members.privyPolicy(userId);
  if (!policy) throw new FundsError('Allow Cult to fund your trades first (approve the trading signer in the app)');

  const signer = signerFor(userId);
  let wallet = await collateralBalance(m.wallet);
  let monSwapped = 0;
  if (wallet < deposit) {
    // Swap just enough MON for the rest, never touching the gas reserve.
    const px = await monPriceAusd();
    const shortUsd = Number(deposit - wallet) / unit;
    const monWei = ethers.parseEther(((shortUsd / px) * (1 + SWAP_SLIPPAGE_BPS / 10_000) * 1.01).toFixed(18));
    const spare = (await rpc().getBalance(m.wallet)) - GAS_RESERVE_WEI - TOPUP_GAS_WEI;
    if (spare < monWei) {
      const have = Number(wallet) / unit + (spare > 0n ? Number(ethers.formatEther(spare)) * px : 0);
      throw new FundsError(`Not enough funds for this trade: it needs $${(Number(deposit) / unit).toFixed(2)} more in margin, you have about $${have.toFixed(2)} (keeping ${ethers.formatEther(GAS_RESERVE_WEI)} MON for fees)`);
    }
    await swap(signer, NATIVE, (await getExchangeInfo()).collateralToken, monWei, { slippageBps: SWAP_SLIPPAGE_BPS });
    monSwapped = Number(ethers.formatEther(monWei));
    wallet = await collateralBalance(m.wallet);
    if (wallet < deposit) deposit = wallet; // slippage: move what arrived
    if (deposit < needRaw - free) throw new FundsError('The MON swap returned less than needed; try a slightly smaller trade');
  }

  // The policy caps each deposit; bigger top-ups go in a few pieces.
  const before = BigInt(session.accounts.get(id)?.b ?? '0');
  for (let left = deposit; left > 0n; ) {
    const piece = left > policy.capRaw ? policy.capRaw : left;
    await depositCollateral(signer, piece);
    left -= piece;
  }
  await creditedBy(session, id, before + deposit);
  console.log(`[margin] ${m.wallet}: +$${(Number(deposit) / unit).toFixed(2)} into Perpl${monSwapped ? ` (${monSwapped} MON swapped)` : ''}`);
  return { depositedAusd: Number(deposit) / unit, monSwapped };
}

// Perpl credits a deposit once it sees the chain event; wait for the account
// update so the order after this isn't refused for margin. Gives up quietly
// after 20s (the order then reports Perpl's own error).
function creditedBy(session: TradingSession, id: number, balanceRaw: bigint): Promise<void> {
  if (BigInt(session.accounts.get(id)?.b ?? '0') >= balanceRaw) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      session.off('account', onAccount);
      resolve();
    };
    const onAccount = (a: { id: number; b: string }) => {
      if (a.id === id && BigInt(a.b) >= balanceRaw) done();
    };
    const timer = setTimeout(done, 20_000);
    session.on('account', onAccount);
  });
}
