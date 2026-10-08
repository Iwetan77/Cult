import { strEnv } from '../config/env.js';

// Aurora Intents Swap API (https://docs.intents.aurora.dev/intents-swap/what-is-swap-api):
// cross-chain swaps on NEAR Intents' 1Click engine, 30+ chains. A quote hands
// out a one-time deposit address; whoever sends the origin asset there gets
// the destination asset delivered to the recipient on the destination chain.
// Nothing to sign beyond that transfer, no bridge UI.
//
// AURORA_INTENTS_API_KEY: from Intents Studio (studio.aurora.dev). Not secret
// per Aurora (it goes in the URL), but we keep it server-side anyway so fee
// settings stay ours. Each key carries our integrator fee (60% of it is ours).

const BASE = 'https://intents-api.aurora.dev';

export const auroraKey = () => strEnv('AURORA_INTENTS_API_KEY', '');
export const intentsEnabled = () => !!auroraKey();

export class IntentsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface IntentToken {
  assetId: string;
  decimals: number;
  blockchain: string; // short chain code: eth, sol, btc, monad, pol, ...
  symbol: string;
  price: number | null; // USD
  contractAddress: string | null;
}

export type SwapStatus = 'KNOWN_DEPOSIT_TX' | 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED';

export interface QuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT' | 'ANY_INPUT';
  depositType: 'ORIGIN_CHAIN' | 'INTENTS';
  originAsset: string;
  destinationAsset: string;
  amount: string; // raw
  slippageTolerance: number; // bps
  refundTo: string;
  refundType: 'ORIGIN_CHAIN' | 'INTENTS';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN' | 'INTENTS';
  deadline?: string;
  referral?: string;
}

export interface Quote {
  timeEstimate: number; // seconds
  deadline: string;
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
}

export interface QuoteResponse {
  correlationId: string;
  quote: Quote;
}

export interface StatusResponse {
  status: SwapStatus;
  updatedAt: string;
  swapDetails?: {
    amountOutFormatted?: string;
    amountOutUsd?: string;
    refundedAmountFormatted?: string;
    refundReason?: string;
    originChainTxHashes?: Array<{ hash: string; explorerUrl?: string }>;
    destinationChainTxHashes?: Array<{ hash: string; explorerUrl?: string }>;
  };
}

type Fetch = typeof fetch;

async function call<T>(path: string, init: RequestInit = {}, fetcher: Fetch = fetch): Promise<T> {
  const key = auroraKey();
  if (!key) throw new IntentsError(409, 'Cross-chain transfers are being switched on. Check back soon.');
  let r: Response;
  try {
    r = await fetcher(`${BASE}${path.replace('{key}', encodeURIComponent(key))}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new IntentsError(503, `Aurora Intents is unreachable right now (${(e as Error).message}).`);
  }
  const text = await r.text();
  if (!r.ok) {
    let message = text.slice(0, 200);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      /* plain text */
    }
    throw new IntentsError(r.status === 404 ? 404 : r.status >= 500 ? 502 : 400, `Aurora Intents: ${message}`);
  }
  return JSON.parse(text) as T;
}

let tokenCache: { at: number; tokens: IntentToken[] } | null = null;

export async function tokens(fetcher?: Fetch): Promise<IntentToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 10 * 60_000) return tokenCache.tokens;
  const body = await call<{ tokens?: IntentToken[] } | IntentToken[]>('/api/tokens/{key}', {}, fetcher);
  const list = (Array.isArray(body) ? body : (body.tokens ?? [])).filter((t) => t.assetId && t.blockchain && t.symbol);
  tokenCache = { at: Date.now(), tokens: list };
  return list;
}

export const quote = (req: QuoteRequest, fetcher?: Fetch) =>
  call<QuoteResponse>('/api/quote/{key}', { method: 'POST', body: JSON.stringify({ referral: 'cult', ...req }) }, fetcher);

export const submitDeposit = (txHash: string, depositAddress: string, memo?: string, fetcher?: Fetch) =>
  call<unknown>('/api/deposit/submit/{key}', { method: 'POST', body: JSON.stringify({ txHash, depositAddress, ...(memo ? { memo } : {}) }) }, fetcher);

export const status = (depositAddress: string, memo?: string, fetcher?: Fetch) =>
  call<StatusResponse>(`/api/status/{key}?depositAddress=${encodeURIComponent(depositAddress)}${memo ? `&depositMemo=${encodeURIComponent(memo)}` : ''}`, {}, fetcher);

export function resetTokenCache() {
  tokenCache = null;
}
