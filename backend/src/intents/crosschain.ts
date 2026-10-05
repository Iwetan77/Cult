import { ethers } from 'ethers';
import { env } from '../config/env.js';
import { erc20Abi } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import { USDC_MAINNET } from '../chain/tokens.js';
import type { WalletAction } from '../accounts/client-flow.js';
import { holdUsdc } from '../funding/usdc.js';
import { getExchangeInfo } from '../perpl/context.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { KURU_FLOW_ROUTER, quoteSwap } from '../swap/kuruFlow.js';
import { IntentsError, quote, status as swapStatusOf, submitDeposit, tokens, type IntentToken, type SwapStatus } from './aurora.js';

// Money in and out of a member's Cult wallet from any chain, on Aurora Intents.
//
// In: pick a coin on another chain (BTC, SOL, USDT on Tron, ETH on Base, ...),
// get a one-time address, send to it from any wallet or exchange. It lands as
// USDC in the member's Cult wallet on Monad, which the backend already turns
// into trading dollars by itself (funding/usdc.ts).
//
// Out: dollars leave as USDC on Monad (AUSD is swapped to USDC first through
// Kuru when needed) and arrive as the coin and chain the member picked. The
// member signs those Monad transactions in the browser; the backend can't move
// their money (its Privy policy has no transfer rule).

const MONAD_USDC_ASSET = 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx';

const CHAINS: Record<string, { name: string; evm: boolean }> = {
  btc: { name: 'Bitcoin', evm: false },
  eth: { name: 'Ethereum', evm: true },
  sol: { name: 'Solana', evm: false },
  base: { name: 'Base', evm: true },
  arb: { name: 'Arbitrum', evm: true },
  bsc: { name: 'BNB Chain', evm: true },
  tron: { name: 'Tron', evm: false },
  ton: { name: 'TON', evm: false },
  sui: { name: 'Sui', evm: false },
  near: { name: 'NEAR', evm: false },
  pol: { name: 'Polygon', evm: true },
  op: { name: 'Optimism', evm: true },
  avax: { name: 'Avalanche', evm: true },
  xrp: { name: 'XRP Ledger', evm: false },
  doge: { name: 'Dogecoin', evm: false },
  zec: { name: 'Zcash', evm: false },
  ltc: { name: 'Litecoin', evm: false },
  bch: { name: 'Bitcoin Cash', evm: false },
  aptos: { name: 'Aptos', evm: false },
  cardano: { name: 'Cardano', evm: false },
  stellar: { name: 'Stellar', evm: false },
  starknet: { name: 'Starknet', evm: false },
  gnosis: { name: 'Gnosis', evm: true },
  bera: { name: 'Berachain', evm: true },
  scroll: { name: 'Scroll', evm: true },
  plasma: { name: 'Plasma', evm: true },
  xlayer: { name: 'X Layer', evm: true },
  monad: { name: 'Monad', evm: true },
};
const ORDER = Object.keys(CHAINS);
const POPULAR = ['USDC', 'USDT', 'BTC', 'ETH', 'SOL', 'TRX', 'TON', 'SUI', 'NEAR', 'XRP', 'DOGE', 'ZEC', 'BNB', 'POL', 'AVAX'];

export interface ChainOption {
  chain: string;
  name: string;
  evm: boolean;
  tokens: Array<{ assetId: string; symbol: string; decimals: number; priceUsd: number | null }>;
}

// Every chain/coin the member can send from (or withdraw to), Monad left out.
export async function chainOptions(): Promise<ChainOption[]> {
  const byChain = new Map<string, ChainOption>();
  for (const t of await tokens()) {
    if (t.blockchain === 'monad') continue;
    const meta = CHAINS[t.blockchain] ?? { name: t.blockchain.toUpperCase(), evm: false };
    const c = byChain.get(t.blockchain) ?? { chain: t.blockchain, name: meta.name, evm: meta.evm, tokens: [] };
    c.tokens.push({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, priceUsd: t.price ?? null });
    byChain.set(t.blockchain, c);
  }
  const rank = (s: string) => (POPULAR.indexOf(s) + 1 || 99);
  for (const c of byChain.values()) c.tokens.sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
  const at = (k: string) => (ORDER.indexOf(k) + 1 || 999);
  return [...byChain.values()].sort((a, b) => at(a.chain) - at(b.chain) || a.name.localeCompare(b.name));
}

async function token(assetId: string): Promise<IntentToken> {
  const t = (await tokens()).find((x) => x.assetId === assetId);
  if (!t) throw new IntentsError(404, 'That coin is not supported for cross-chain transfers.');
  return t;
}

async function monadUsdcAsset(): Promise<string> {
  const t = (await tokens()).find((x) => x.blockchain === 'monad' && x.symbol === 'USDC');
  return t?.assetId ?? MONAD_USDC_ASSET;
}

function mainnetOnly() {
  if (env.chainId !== 143) throw new IntentsError(409, 'Cross-chain transfers work on Monad mainnet only.');
}

function toRaw(amount: string | number, decimals: number): bigint {
  const s = typeof amount === 'number' ? amount.toFixed(decimals) : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new IntentsError(400, 'Enter an amount.');
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function validRecipient(chain: string, address: string): boolean {
  const a = address.trim();
  if (!a || a.length > 128 || /\s/.test(a)) return false;
  if (CHAINS[chain]?.evm) return ethers.isAddress(a);
  if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  if (chain === 'tron') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
  if (chain === 'btc') return /^(bc1[a-z0-9]{25,62}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a);
  if (chain === 'sui' || chain === 'aptos') return /^0x[0-9a-fA-F]{64}$/.test(a);
  return true; // the quote itself rejects anything malformed
}

export interface SwapView {
  depositAddress: string;
  depositMemo: string | null;
  kind: 'deposit' | 'withdraw';
  chain: string;
  chainName: string;
  symbol: string;
  amountIn: string; // human, origin units
  amountInUsd: number | null;
  receive: string; // human, destination units
  receiveSymbol: string;
  receiveUsd: number | null;
  minReceive: string;
  seconds: number;
  deadline: string;
  status: SwapStatus;
}

const num = (s: string | undefined) => (s != null && Number.isFinite(Number(s)) ? Number(s) : null);

function record(userId: string, kind: 'deposit' | 'withdraw', origin: string, dest: string, amountRaw: bigint, outUsd: number | null, recipient: string, depositAddress: string, memo: string | null, deadline: string) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO intent_swaps (deposit_address, user_id, kind, origin_asset, destination_asset, amount_in, amount_out_usd, recipient, memo, status, deadline, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_DEPOSIT', ?, ?, ?)`,
    )
    .run(depositAddress, userId, kind, origin, dest, amountRaw.toString(), outUsd, recipient, memo, deadline, now, now);
}

// In: a one-time address on the origin chain; what's sent there arrives as
// USDC in the member's Cult wallet on Monad. Refunds (e.g. sent too late) go
// back to `refundTo` on the origin chain; without one, to the member's own
// address there (EVM chains) or to their NEAR Intents account (others), from
// which support can return it.
export async function depositQuote(userId: string, b: { originAsset: string; amount: string; refundTo?: string }): Promise<SwapView> {
  mainnetOnly();
  const m = members.get(userId)!;
  const from = await token(b.originAsset);
  if (from.blockchain === 'monad') throw new IntentsError(400, 'That coin is already on Monad: send it straight to your Cult address.');
  const raw = toRaw(b.amount, from.decimals);
  if (raw <= 0n) throw new IntentsError(400, 'Enter an amount.');
  const evm = CHAINS[from.blockchain]?.evm ?? false;
  if (b.refundTo && !validRecipient(from.blockchain, b.refundTo)) throw new IntentsError(400, `That doesn't look like a ${CHAINS[from.blockchain]?.name ?? from.blockchain} address.`);
  const refund = b.refundTo ? { refundTo: b.refundTo.trim(), refundType: 'ORIGIN_CHAIN' as const } : evm ? { refundTo: ethers.getAddress(m.wallet), refundType: 'ORIGIN_CHAIN' as const } : { refundTo: m.wallet.toLowerCase(), refundType: 'INTENTS' as const };
  const dest = await monadUsdcAsset();
  const { quote: q } = await quote({
    dry: false,
    swapType: 'EXACT_INPUT',
    depositType: 'ORIGIN_CHAIN',
    originAsset: from.assetId,
    destinationAsset: dest,
    amount: raw.toString(),
    slippageTolerance: 100,
    ...refund,
    recipient: ethers.getAddress(m.wallet),
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  });
  if (!q.depositAddress) throw new IntentsError(502, 'Aurora Intents returned no deposit address.');
  record(userId, 'deposit', from.assetId, dest, raw, num(q.amountOutUsd), m.wallet, q.depositAddress, q.depositMemo ?? null, q.deadline);
  return view('deposit', from, 'USDC', q.depositAddress, q.depositMemo ?? null, q, 'PENDING_DEPOSIT');
}

export interface WithdrawPlan extends SwapView {
  actions: WalletAction[]; // sign on Monad, in order
}

// Out: $amountUsd from the Cult wallet to `recipient` on the chain/coin of
// `destinationAsset`.
export async function withdrawPlan(userId: string, b: { destinationAsset: string; amountUsd: number; recipient: string }): Promise<WithdrawPlan> {
  mainnetOnly();
  const m = members.get(userId)!;
  const to = await token(b.destinationAsset);
  if (to.blockchain === 'monad') throw new IntentsError(400, 'For Monad, use the regular withdraw.');
  if (!validRecipient(to.blockchain, b.recipient)) throw new IntentsError(400, `That doesn't look like a ${CHAINS[to.blockchain]?.name ?? to.blockchain} address.`);
  if (!(b.amountUsd >= 5)) throw new IntentsError(400, 'The smallest cross-chain withdrawal is $5.');
  const need = toRaw(b.amountUsd, 6);

  const usdcC = new ethers.Contract(USDC_MAINNET, erc20Abi, rpc());
  const { collateralToken: ausd, collateralDecimals } = await getExchangeInfo();
  const ausdC = new ethers.Contract(ausd, erc20Abi, rpc());
  const [usdcHave, ausdHave] = (await Promise.all([usdcC.getFunction('balanceOf')(m.wallet), ausdC.getFunction('balanceOf')(m.wallet)])) as [bigint, bigint];

  const actions: WalletAction[] = [];
  let sendable = usdcHave < need ? usdcHave : need;
  if (usdcHave < need) {
    // Dollars are AUSD: swap the rest to USDC first (1:1-ish through Kuru's stable pool).
    const shortUsdc = need - usdcHave;
    const ausdIn = (shortUsdc * 10n ** BigInt(collateralDecimals)) / 10n ** 6n;
    const withBuffer = (ausdIn * 1003n) / 1000n;
    if (ausdHave < withBuffer) throw new IntentsError(409, `You have $${Number(ethers.formatUnits(ausdHave + (usdcHave * 10n ** BigInt(collateralDecimals)) / 10n ** 6n, collateralDecimals)).toFixed(2)} to withdraw.`);
    const q = await quoteSwap(m.wallet, ausd, USDC_MAINNET, withBuffer, 30);
    const allowance: bigint = await ausdC.getFunction('allowance')(m.wallet, KURU_FLOW_ROUTER);
    if (allowance < withBuffer) actions.push({ to: ausd, data: erc20Abi.encodeFunctionData('approve', [KURU_FLOW_ROUTER, withBuffer]), chainId: env.chainId, label: 'Approve dollars for the swap' });
    actions.push({ to: q.tx.to, data: q.tx.data, ...(q.tx.value ? { value: ethers.toQuantity(q.tx.value) } : {}), chainId: env.chainId, label: 'Swap dollars to USDC' });
    sendable = usdcHave + (q.minOut < shortUsdc ? q.minOut : shortUsdc);
  }

  const { quote: q } = await quote({
    dry: false,
    swapType: 'EXACT_INPUT',
    depositType: 'ORIGIN_CHAIN',
    originAsset: await monadUsdcAsset(),
    destinationAsset: to.assetId,
    amount: sendable.toString(),
    slippageTolerance: 100,
    refundTo: ethers.getAddress(m.wallet),
    refundType: 'ORIGIN_CHAIN',
    recipient: b.recipient.trim(),
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  });
  if (!q.depositAddress) throw new IntentsError(502, 'Aurora Intents returned no deposit address.');
  actions.push({ to: USDC_MAINNET, data: erc20Abi.encodeFunctionData('transfer', [q.depositAddress, sendable]), chainId: env.chainId, label: `Send $${b.amountUsd.toFixed(2)} to ${CHAINS[to.blockchain]?.name ?? to.blockchain}` });
  holdUsdc(userId);
  record(userId, 'withdraw', await monadUsdcAsset(), to.assetId, sendable, num(q.amountOutUsd), b.recipient.trim(), q.depositAddress, q.depositMemo ?? null, q.deadline);
  const usdc: IntentToken = { assetId: MONAD_USDC_ASSET, decimals: 6, blockchain: 'monad', symbol: 'USDC', price: 1, contractAddress: USDC_MAINNET };
  return { ...view('withdraw', usdc, to.symbol, q.depositAddress, q.depositMemo ?? null, q, 'PENDING_DEPOSIT', to.blockchain), actions };
}

function view(kind: 'deposit' | 'withdraw', from: IntentToken, receiveSymbol: string, depositAddress: string, memo: string | null, q: Awaited<ReturnType<typeof quote>>['quote'], s: SwapStatus, destChain?: string): SwapView {
  const chain = kind === 'deposit' ? from.blockchain : destChain!;
  return {
    depositAddress,
    depositMemo: memo,
    kind,
    chain,
    chainName: CHAINS[chain]?.name ?? chain,
    symbol: from.symbol,
    amountIn: q.amountInFormatted,
    amountInUsd: num(q.amountInUsd),
    receive: q.amountOutFormatted,
    receiveSymbol,
    receiveUsd: num(q.amountOutUsd),
    minReceive: q.minAmountOut,
    seconds: q.timeEstimate,
    deadline: q.deadline,
    status: s,
  };
}

interface SwapRow {
  deposit_address: string;
  user_id: string;
  kind: 'deposit' | 'withdraw';
  memo: string | null;
  status: SwapStatus;
}

function own(userId: string, depositAddress: string): SwapRow {
  const row = getDb().prepare('SELECT * FROM intent_swaps WHERE deposit_address = ?').get(depositAddress) as SwapRow | undefined;
  if (!row || row.user_id !== userId) throw new IntentsError(404, 'Unknown transfer.');
  return row;
}

export async function swapStatus(userId: string, depositAddress: string) {
  const row = own(userId, depositAddress);
  const s = await swapStatusOf(depositAddress, row.memo ?? undefined);
  if (s.status !== row.status) getDb().prepare('UPDATE intent_swaps SET status = ?, updated_at = ? WHERE deposit_address = ?').run(s.status, Date.now(), depositAddress);
  return {
    status: s.status,
    done: s.status === 'SUCCESS' || s.status === 'REFUNDED' || s.status === 'FAILED',
    received: s.swapDetails?.amountOutFormatted ?? null,
    receivedUsd: num(s.swapDetails?.amountOutUsd),
    refunded: s.swapDetails?.refundedAmountFormatted ?? null,
    refundReason: s.swapDetails?.refundReason ?? null,
    txs: [...(s.swapDetails?.originChainTxHashes ?? []), ...(s.swapDetails?.destinationChainTxHashes ?? [])].map((t) => ({ hash: t.hash, url: t.explorerUrl ?? null })),
  };
}

// The member (or our frontend) knows the deposit tx: tell 1Click so it's picked up sooner.
export async function tellDeposit(userId: string, depositAddress: string, txHash: string) {
  const row = own(userId, depositAddress);
  await submitDeposit(txHash, depositAddress, row.memo ?? undefined);
}

export function recentSwaps(userId: string, limit = 20) {
  return getDb().prepare('SELECT deposit_address AS depositAddress, kind, origin_asset AS originAsset, destination_asset AS destinationAsset, amount_out_usd AS amountOutUsd, recipient, status, created_at AS createdAt FROM intent_swaps WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}
