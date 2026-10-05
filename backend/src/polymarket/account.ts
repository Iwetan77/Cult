import { ethers } from 'ethers';
import { SessionKeyKnownScope } from '@polymarket/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { env } from '../config/env.js';
import { erc20Abi } from '../chain/exchange.js';
import type { WalletAction } from '../accounts/client-flow.js';
import { getExchangeInfo } from '../perpl/context.js';
import { members } from '../store/members.js';
import { SignatureBroker, FlowError, type FlowStep, type TypedDataJson } from './broker.js';
import { builderCreds, forgetSession, ownerClient, polygonRpc, predictionsEnabled, PUSD, sessionKeysWanted } from './client.js';
import { predictionAccounts } from './store.js';

// A member's Polymarket account: open it (Deposit Wallet + approvals + our
// trading key), see what's in it, move dollars in from their Cult wallet on
// Monad and back out. Every step that touches their money is signed by their
// own wallet in the browser (see broker.ts). Dollars on Polymarket are pUSD.

export const broker = new SignatureBroker(labelFor);

const SESSION_RETRY_MS = 6 * 3_600_000; // refused session-key authorization: try again later
const BRIDGE = 'https://bridge.polymarket.com';
const POLYGON = '137';

export type PredictionStep = 'unavailable' | 'needs_setup' | 'needs_funds' | 'ready';

export interface PredictionAccountView {
  enabled: boolean;
  step: PredictionStep;
  reason: string | null; // why it's unavailable, in plain words
  wallet: string | null; // their Polymarket Deposit Wallet on Polygon
  balanceUsd: number | null; // pUSD ready to bet
  signsEachBet: boolean; // no trading key yet: each bet asks for a signature
  funding: { from: 'AUSD'; minUsd: number; network: string } | null;
}

export async function accountView(userId: string): Promise<PredictionAccountView> {
  const base = { wallet: null, balanceUsd: null, signsEachBet: true, funding: null };
  if (!builderCreds()) return { ...base, enabled: false, step: 'unavailable', reason: 'Predictions are being switched on. Check back soon.' };
  if (!predictionsEnabled()) return { ...base, enabled: false, step: 'unavailable', reason: 'Predictions are paused right now.' };
  const acct = predictionAccounts.get(userId);
  if (!acct || !acct.deployed || !acct.approvals) return { ...base, enabled: true, step: 'needs_setup', reason: null };
  const balanceUsd = await pusdBalance(acct.depositWallet).catch(() => null);
  return {
    enabled: true,
    step: balanceUsd != null && balanceUsd < 0.5 ? 'needs_funds' : 'ready',
    reason: null,
    wallet: ethers.getAddress(acct.depositWallet),
    balanceUsd,
    signsEachBet: !predictionAccounts.sessionKey(userId),
    funding: env.chainId === 143 ? { from: 'AUSD', minUsd: 2, network: 'Monad' } : null,
  };
}

// Open (or finish opening) the account. Up to four signatures the first time:
// sign in to Polymarket, approvals, and the trading key; deployment is gasless.
// Running it again only asks for what's missing.
export async function startSetup(userId: string): Promise<FlowStep<PredictionAccountView>> {
  if (!predictionsEnabled()) throw new FlowError(409, 'Predictions are not available yet.');
  const m = members.get(userId)!;
  return broker.start(userId, m.wallet, 'Set up predictions', async (signer) => {
    const client = await ownerClient(userId, signer);
    predictionAccounts.ensure(userId, m.wallet, client.account.wallet);
    predictionAccounts.setCreds(userId, client.credentials);
    predictionAccounts.setDeployed(userId);

    const approvals = await client.fetchTradingApprovalsState();
    if (!approvals.isFullyApproved) await client.setupTradingApprovals();
    predictionAccounts.setApprovals(userId, true);

    const acct = predictionAccounts.get(userId)!;
    const retryLater = acct.sessionRetryAt != null && acct.sessionRetryAt > Date.now();
    if (sessionKeysWanted() && !predictionAccounts.sessionKey(userId) && !retryLater) {
      const key = generatePrivateKey();
      const address = privateKeyToAccount(key).address;
      try {
        const auth = await client.authorizeSessionKey({ address, scopes: [SessionKeyKnownScope.CLOB] });
        predictionAccounts.setSession(userId, address, key, Number(auth.sessionKey.validUntil ?? Math.floor(Date.now() / 1000) + 179 * 86_400));
        forgetSession(userId);
      } catch (e) {
        // Most often: session keys aren't enabled for our builder key yet.
        // Bets still work; each one asks the member to sign.
        if (e instanceof FlowError) throw e;
        console.warn(`[predictions] session key refused for ${userId.slice(-8)}: ${(e as Error).message}`);
        predictionAccounts.clearSession(userId, Date.now() + SESSION_RETRY_MS);
      }
    }
    return accountView(userId);
  });
}

// pUSD in a Deposit Wallet, in dollars. Polygon RPC, cached a few seconds.
const balances = new Map<string, { at: number; usd: number }>();
let polygon: ethers.JsonRpcProvider | null = null;
export async function pusdBalance(wallet: string): Promise<number> {
  const hit = balances.get(wallet);
  if (hit && Date.now() - hit.at < 8_000) return hit.usd;
  polygon ??= new ethers.JsonRpcProvider(polygonRpc(), 137, { staticNetwork: true });
  const raw: bigint = await new ethers.Contract(PUSD, erc20Abi, polygon).getFunction('balanceOf')(wallet);
  const usd = Number(ethers.formatUnits(raw, 6));
  balances.set(wallet, { at: Date.now(), usd });
  return usd;
}
export const forgetBalance = (wallet: string) => balances.delete(wallet);

// --- moving dollars in and out -------------------------------------------------

async function bridgePost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  if (!r.ok) throw new FlowError(409, `Polymarket's bridge said no: ${text.slice(0, 160)}`);
  return JSON.parse(text) as T;
}

interface BridgeQuote {
  estCheckoutTimeMs: number;
  estOutputUsd: number;
  estFeeBreakdown?: { minReceived?: number };
}

export interface FundPlan {
  actions: WalletAction[]; // sign these on Monad, in order
  depositAddress: string;
  amountUsd: number;
  receiveUsd: number | null;
  seconds: number | null;
}

// Dollars (AUSD) from the member's Cult wallet on Monad into their Polymarket
// account: one transfer to their own bridge address, which credits pUSD to
// their Deposit Wallet in about half a minute. The member signs it.
export async function fundPlan(userId: string, amountUsd: number): Promise<FundPlan> {
  if (env.chainId !== 143) throw new FlowError(409, 'Moving dollars to predictions works on Monad mainnet only.');
  const acct = predictionAccounts.get(userId);
  if (!acct?.deployed) throw new FlowError(409, 'Set up predictions first.');
  if (!(amountUsd >= 2)) throw new FlowError(400, 'The smallest move is $2.');
  const m = members.get(userId)!;
  const { collateralToken, collateralDecimals } = await getExchangeInfo();
  const raw = ethers.parseUnits(amountUsd.toFixed(collateralDecimals), collateralDecimals);
  const { rpc } = await import('../chain/signer.js');
  const have: bigint = await new ethers.Contract(collateralToken, erc20Abi, rpc()).getFunction('balanceOf')(m.wallet);
  if (have < raw) throw new FlowError(409, `You have $${Number(ethers.formatUnits(have, collateralDecimals)).toFixed(2)} in your wallet.`);
  const { address } = await bridgePost<{ address: { evm: string } }>('/deposit', { address: ethers.getAddress(acct.depositWallet) });
  const quote = await bridgePost<BridgeQuote>('/quote', {
    fromAmountBaseUnit: raw.toString(),
    fromChainId: String(env.chainId),
    fromTokenAddress: collateralToken,
    recipientAddress: ethers.getAddress(acct.depositWallet),
    toChainId: POLYGON,
    toTokenAddress: PUSD,
  }).catch(() => null);
  forgetBalance(acct.depositWallet);
  return {
    actions: [{ to: collateralToken, data: erc20Abi.encodeFunctionData('transfer', [address.evm, raw]), chainId: env.chainId, label: `Move $${amountUsd.toFixed(2)} to predictions` }],
    depositAddress: address.evm,
    amountUsd,
    receiveUsd: quote?.estFeeBreakdown?.minReceived ?? quote?.estOutputUsd ?? null,
    seconds: quote ? Math.round(quote.estCheckoutTimeMs / 1000) : null,
  };
}

// pUSD back to the member's Cult wallet as AUSD on Monad: a transfer from
// their Deposit Wallet to their own bridge withdrawal address, signed by them.
export async function startWithdraw(userId: string, amountUsd: number): Promise<FlowStep<{ amountUsd: number; tx: string | null; seconds: number }>> {
  if (env.chainId !== 143) throw new FlowError(409, 'Moving dollars back works on Monad mainnet only.');
  const acct = predictionAccounts.get(userId);
  if (!acct?.deployed) throw new FlowError(409, 'Set up predictions first.');
  if (!(amountUsd >= 2)) throw new FlowError(400, 'The smallest move is $2.');
  const balance = await pusdBalance(acct.depositWallet);
  if (amountUsd > balance + 1e-6) throw new FlowError(409, `You have $${balance.toFixed(2)} in predictions.`);
  const m = members.get(userId)!;
  const { collateralToken } = await getExchangeInfo();
  const { address } = await bridgePost<{ address: { evm: string } }>('/withdraw', {
    address: ethers.getAddress(acct.depositWallet),
    toChainId: String(env.chainId),
    toTokenAddress: collateralToken,
    recipientAddr: ethers.getAddress(m.wallet),
  });
  const amount = ethers.parseUnits(amountUsd.toFixed(6), 6);
  return broker.start(userId, m.wallet, 'Move dollars back to your wallet', async (signer) => {
    const client = await ownerClient(userId, signer, acct.depositWallet);
    const handle = await client.transferErc20({ amount, recipientAddress: address.evm as `0x${string}`, tokenAddress: PUSD, metadata: 'Cult withdraw' } as never);
    const outcome = await handle.wait();
    forgetBalance(acct.depositWallet);
    return { amountUsd, tx: outcome.transactionHash ?? null, seconds: 30 };
  });
}

// --- what the member is asked to sign, in plain words ---------------------------

const SELECTORS: Record<string, string> = {
  '0x095ea7b3': 'approve',
  '0xa22cb465': 'approveAll',
  '0xa9059cbb': 'transfer',
  [ethers.id('authorizeSessionSigner(address,uint256)').slice(0, 10)]: 'session',
};

export function labelFor(td: TypedDataJson | null): string {
  if (!td) return 'Approve in your wallet';
  const name = String(td.domain.name ?? '');
  if (name === 'ClobAuthDomain') return 'Sign in to Polymarket';
  if (/CTF Exchange/i.test(name)) return 'Confirm your bet';
  if (name === 'DepositWallet') {
    const calls = (td.message.calls as Array<{ data?: string }> | undefined) ?? [];
    const kinds = new Set(calls.map((c) => SELECTORS[String(c.data ?? '').slice(0, 10).toLowerCase()] ?? 'other'));
    if (kinds.has('session')) return 'Let Cult place your bets (it can never withdraw)';
    if (kinds.has('transfer')) return 'Move your dollars';
    if (kinds.has('approve') || kinds.has('approveAll')) return 'Turn on trading for your account';
    return 'Confirm on Polymarket';
  }
  return 'Approve in your wallet';
}
