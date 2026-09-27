import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { env, numEnv } from '../config/env.js';
import { erc20Abi, exchangeAbi, getOnChainAccount } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import { getExchangeInfo } from '../perpl/context.js';
import { KURU_FLOW_ROUTER, quoteSwap, SwapUnavailable } from '../swap/kuruFlow.js';

// Circle USDC on Monad mainnet.
export const USDC_MAINNET = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

// "Pay with USDC": USDC -> AUSD through Kuru Flow (which routes via the deep
// AUSD/USDC stable pool), then optionally straight into the member's Perpl
// account, as one ordered list of wallet actions the member signs in the
// browser. The app shows dollars; the member never handles AUSD.
//
// Mainnet only: Kuru Flow routes Monad mainnet liquidity, and mainnet AUSD
// can only fund mainnet Perpl. Without the Perpl deposit, the AUSD stays in
// the wallet, which is what meme buys are paid from.

export interface WalletAction {
  to: string;
  data: string;
  value?: string;
  chainId: number;
  label: string;
}

export interface FundingPlan {
  id: string;
  expiresAt: string;
  requiredUsdc: string; // raw, 6dp
  minAusdOut: string; // raw, 6dp; guaranteed by the swap
  expectedAusdOut: string; // raw, 6dp; what the route quotes
  depositToPerpl: boolean;
  actions: WalletAction[];
}

const plans = new Map<string, FundingPlan & { wallet: string; expires: number }>();

export class FundingUnavailable extends Error {}

export async function prepareUsdcFunding(wallet: string, usdcIn: bigint, depositToPerpl = true): Promise<FundingPlan> {
  if (env.chainId !== 143) {
    throw new FundingUnavailable('Paying with USDC works on Monad mainnet only (Kuru routes mainnet liquidity). Deposit AUSD directly.');
  }
  const { exchange, collateralToken, minAccountOpen, minDeposit } = await getExchangeInfo();
  let q;
  try {
    q = await quoteSwap(wallet, USDC_MAINNET, collateralToken, usdcIn, numEnv('FUNDING_SLIPPAGE_BPS', 30));
  } catch (e) {
    if (e instanceof SwapUnavailable) throw new FundingUnavailable(`No USDC route right now (${e.message}). Deposit AUSD directly.`);
    throw e;
  }

  const actions: WalletAction[] = [];
  const usdc = new ethers.Contract(USDC_MAINNET, erc20Abi, rpc());
  if ((await usdc.getFunction('allowance')(wallet, KURU_FLOW_ROUTER)) < usdcIn) {
    actions.push({ to: USDC_MAINNET, data: erc20Abi.encodeFunctionData('approve', [KURU_FLOW_ROUTER, usdcIn]), chainId: env.chainId, label: 'approve USDC' });
  }
  actions.push({ to: q.tx.to, data: q.tx.data, value: q.tx.value ? ethers.toQuantity(q.tx.value) : undefined, chainId: env.chainId, label: 'swap USDC to dollars (AUSD)' });

  if (depositToPerpl) {
    const hasAccount = !!(await getOnChainAccount(wallet));
    const floor = hasAccount ? minDeposit : minAccountOpen;
    if (q.minOut < floor) throw new FundingUnavailable(`Fund at least $${ethers.formatUnits(floor, 6)} to ${hasAccount ? 'top up' : 'open'} a Perpl account.`);
    // Deposit the swap's guaranteed minimum; anything above it stays in the wallet.
    actions.push({ to: collateralToken, data: erc20Abi.encodeFunctionData('approve', [exchange, q.minOut]), chainId: env.chainId, label: 'approve for Perpl' });
    actions.push({
      to: exchange,
      data: exchangeAbi.encodeFunctionData(hasAccount ? 'depositCollateral' : 'createAccount', [q.minOut]),
      chainId: env.chainId,
      label: hasAccount ? 'deposit into Perpl' : 'open Perpl account',
    });
  }

  const expires = Date.now() + 5 * 60_000; // routes go stale; re-prepare after this
  const plan: FundingPlan = {
    id: randomUUID(),
    expiresAt: new Date(expires).toISOString(),
    requiredUsdc: usdcIn.toString(),
    minAusdOut: q.minOut.toString(),
    expectedAusdOut: q.out.toString(),
    depositToPerpl,
    actions,
  };
  plans.set(plan.id, { ...plan, wallet: wallet.toLowerCase(), expires });
  return plan;
}

// Checks the member's submitted txs against the plan: each mined, from the
// member, to the planned contract with the planned calldata, in order.
export async function confirmFunding(wallet: string, planId: string, hashes: string[]) {
  const plan = plans.get(planId);
  if (!plan || plan.wallet !== wallet.toLowerCase()) throw new Error('unknown funding plan');
  if (hashes.length !== plan.actions.length) throw new Error(`expected ${plan.actions.length} tx hashes, got ${hashes.length}`);
  const steps = [];
  for (const [i, h] of hashes.entries()) {
    const [tx, rcpt] = await Promise.all([rpc().getTransaction(h), rpc().getTransactionReceipt(h)]);
    const a = plan.actions[i]!;
    const ok =
      !!tx && !!rcpt && rcpt.status === 1 && tx.from.toLowerCase() === plan.wallet && tx.to?.toLowerCase() === a.to.toLowerCase() && tx.data === a.data;
    steps.push({ label: a.label, txHash: h, ok });
  }
  const account = await getOnChainAccount(plan.wallet);
  return { planId, done: steps.every((s) => s.ok) && !!account, steps, perplAccountId: account ? Number(account.accountId) : null };
}
