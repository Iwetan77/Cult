import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { env } from '../config/env.js';
import { erc20Abi, exchangeAbi, getOnChainAccount } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import { getExchangeInfo } from '../perpl/context.js';
import { kuruMarket, marketBuyCalldata } from './kuru.js';

// "Pay with USDC": USDC -> AUSD on Kuru, then straight into the member's
// Perpl account, as one ordered list of wallet actions the member signs in the
// browser. The app only ever shows AUSD; the member never handles it.
//
// Only meaningful on mainnet: Kuru's AUSD/USDC book only exists there, and
// mainnet AUSD can only fund mainnet Perpl.

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
  minAusdOut: string; // raw, 6dp
  actions: WalletAction[];
}

const plans = new Map<string, FundingPlan & { wallet: string; expires: number }>();
const SLIPPAGE_BPS = BigInt(process.env.FUNDING_SLIPPAGE_BPS ?? 30); // AUSD/USDC should trade ~1:1

export class FundingUnavailable extends Error {}

export async function prepareUsdcFunding(wallet: string, usdcIn: bigint): Promise<FundingPlan> {
  if (env.chainId !== 143) {
    throw new FundingUnavailable('USDC funding runs on Monad mainnet only (Kuru has no AUSD market on testnet). Deposit AUSD directly.');
  }
  const m = await kuruMarket();
  if (!m.hasAsks) throw new FundingUnavailable('Kuru AUSD/USDC has no liquidity to buy from right now. Deposit AUSD directly.');
  const { exchange, collateralToken, minAccountOpen, minDeposit } = await getExchangeInfo();
  if (m.baseAsset.toLowerCase() !== collateralToken.toLowerCase()) throw new Error('Kuru market base is not the Perpl collateral token');

  const minAusdOut = usdcIn - (usdcIn * SLIPPAGE_BPS) / 10_000n;
  const hasAccount = !!(await getOnChainAccount(wallet));
  const floor = hasAccount ? minDeposit : minAccountOpen;
  if (minAusdOut < floor) throw new FundingUnavailable(`fund at least ${ethers.formatUnits(floor, 6)} AUSD worth of USDC`);

  const usdc = new ethers.Contract(m.quoteAsset, erc20Abi, rpc());
  const actions: WalletAction[] = [];
  if ((await usdc.getFunction('allowance')(wallet, m.address)) < usdcIn) {
    actions.push({ to: m.quoteAsset, data: erc20Abi.encodeFunctionData('approve', [m.address, usdcIn]), chainId: env.chainId, label: 'approve USDC to Kuru' });
  }
  actions.push({ to: m.address, data: marketBuyCalldata(m, usdcIn, minAusdOut), chainId: env.chainId, label: 'swap USDC to AUSD on Kuru' });
  // Deposit the guaranteed minimum; any extra from the swap stays in the wallet.
  actions.push({ to: collateralToken, data: erc20Abi.encodeFunctionData('approve', [exchange, minAusdOut]), chainId: env.chainId, label: 'approve AUSD to Perpl' });
  actions.push({
    to: exchange,
    data: exchangeAbi.encodeFunctionData(hasAccount ? 'depositCollateral' : 'createAccount', [minAusdOut]),
    chainId: env.chainId,
    label: hasAccount ? 'deposit into Perpl' : 'open Perpl account',
  });

  const plan = { id: randomUUID(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), requiredUsdc: usdcIn.toString(), minAusdOut: minAusdOut.toString(), actions };
  plans.set(plan.id, { ...plan, wallet: wallet.toLowerCase(), expires: Date.now() + 10 * 60_000 });
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
