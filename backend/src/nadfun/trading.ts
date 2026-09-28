import { ethers } from 'ethers';
import { rpc, type WalletSigner } from '../chain/signer.js';
import { NADFUN } from './constants.js';
import { getJson } from '../http.js';

// Nad.fun v2 via its router. Every trade is a transaction from the member's
// own wallet (no API key like Perpl), which is why Privy's policy is the cap
// for this venue: router only, `to` = the member, MON value capped.

export const routerAbi = new ethers.Interface([
  'function buyWithNative((uint256 amountOutMin, address token, address to, uint256 deadline) params) payable returns (uint256 amountOut)',
  'function sellToNative((uint256 amountIn, uint256 amountOutMin, address token, address to, uint256 deadline) params) returns (uint256 amountOut)',
  'function getAmountOut(address token, uint256 amountIn, bool isBuy) view returns (uint256 amountOut)',
  'function isGraduated(address token) view returns (bool)',
  'event Buy(address indexed buyer, address indexed token, uint256 amountIn, uint256 amountOut, bool graduated)',
  'event Sell(address indexed seller, address indexed token, uint256 amountIn, uint256 amountOut, bool graduated)',
]);

export const tokenAbi = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const router = () => new ethers.Contract(NADFUN.router, routerAbi, rpc());
const token = (addr: string) => new ethers.Contract(addr, tokenAbi, rpc());
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);
const withSlippage = (amount: bigint, bps: number) => (amount * BigInt(10_000 - bps)) / 10_000n;

export interface NadMarket {
  token: string;
  symbol: string;
  name: string;
  quoteToken: string;
  graduated: boolean;
  priceMon: number; // MON per token, from the API
  imageUri?: string;
}

// Live token list from Nad.fun's API, filtered to MON-quoted tokens, the only
// ones Cult trades (see CONTRACTS.md, decision 2).
export async function listMonMarkets(order: 'latest_trade' | 'market_cap' | 'creation_time' = 'latest_trade', limit = 50): Promise<NadMarket[]> {
  const body = await getJson<{ tokens: { token_info: any; market_info: any }[] }>(`${NADFUN.apiUrl}/order/${order}?page=1&limit=${limit}`);
  return toNadMarkets(body.tokens);
}

// Nad.fun's own search (name, symbol), so any meme can be found, not just the
// ones in our list. Same token shape as the lists.
export async function searchMonMarkets(keyword: string): Promise<NadMarket[]> {
  const body = await getJson<{ token_result?: { tokens?: { token_info: any; market_info: any }[] } }>(
    `${NADFUN.apiUrl}/search/token?keyword=${encodeURIComponent(keyword)}`,
  );
  return toNadMarkets(body.token_result?.tokens ?? []);
}

function toNadMarkets(tokens: { token_info: any; market_info: any }[]): NadMarket[] {
  return tokens
    .filter((t) => t.market_info?.quote_info?.quote_id?.toLowerCase() === NADFUN.wmon.toLowerCase())
    .map((t) => ({
      token: ethers.getAddress(t.token_info.token_id),
      symbol: t.token_info.symbol,
      name: t.token_info.name,
      quoteToken: t.market_info.quote_info.quote_id,
      graduated: !!t.token_info.is_graduated,
      priceMon: Number(t.market_info.price_native ?? t.market_info.price ?? 0),
      imageUri: t.token_info.image_uri,
    }));
}

export async function quoteBuy(tokenAddr: string, monIn: bigint): Promise<bigint> {
  return router().getFunction('getAmountOut')(tokenAddr, monIn, true);
}

export async function quoteSell(tokenAddr: string, tokensIn: bigint): Promise<bigint> {
  return router().getFunction('getAmountOut')(tokenAddr, tokensIn, false);
}

export async function tokenBalance(tokenAddr: string, owner: string, blockTag?: number): Promise<bigint> {
  return token(tokenAddr).getFunction('balanceOf')(owner, blockTag != null ? { blockTag } : {});
}

export interface NadFill {
  txHash: string;
  token: string;
  side: 'buy' | 'sell';
  monAmount: bigint; // MON spent (buy) or received (sell)
  tokenAmount: bigint; // tokens received (buy) or sold (sell)
  graduated: boolean;
}

async function fillFromReceipt(txHash: string, side: 'buy' | 'sell', trader: string): Promise<NadFill> {
  const rcpt = await rpc().getTransactionReceipt(txHash);
  if (!rcpt) throw new Error(`no receipt for ${txHash}`);
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== NADFUN.router.toLowerCase()) continue;
    const ev = routerAbi.parseLog(log);
    if (!ev || ev.name.toLowerCase() !== side) continue;
    if ((ev.args[0] as string).toLowerCase() !== trader.toLowerCase()) continue;
    return side === 'buy'
      ? { txHash, token: ev.args[1], side, monAmount: ev.args[2], tokenAmount: ev.args[3], graduated: ev.args[4] }
      : { txHash, token: ev.args[1], side, tokenAmount: ev.args[2], monAmount: ev.args[3], graduated: ev.args[4] };
  }
  throw new Error(`router ${side} event not found in ${txHash}`);
}

// Buys `monIn` worth of `tokenAddr`, tokens delivered to the signer itself.
export async function buy(signer: WalletSigner, tokenAddr: string, monIn: bigint, slippageBps = 300, onHash?: (h: string) => void): Promise<NadFill> {
  const expected = await quoteBuy(tokenAddr, monIn);
  if (expected === 0n) throw new Error(`nad.fun quotes 0 tokens for ${ethers.formatEther(monIn)} MON`);
  const data = routerAbi.encodeFunctionData('buyWithNative', [
    { amountOutMin: withSlippage(expected, slippageBps), token: tokenAddr, to: signer.address, deadline: deadline() },
  ]);
  const txHash = await signer.sendTransaction({ to: NADFUN.router, data, value: monIn }, { onHash });
  return fillFromReceipt(txHash, 'buy', signer.address);
}

// Sells `tokensIn` (default: the whole balance) back to MON, paid to the signer.
export async function sell(
  signer: WalletSigner,
  tokenAddr: string,
  tokensIn?: bigint,
  slippageBps = 300,
  onHash?: (h: string) => void,
): Promise<NadFill & { approveTx: string | null }> {
  const held = await tokenBalance(tokenAddr, signer.address);
  const amount = tokensIn != null && tokensIn < held ? tokensIn : held;
  if (amount === 0n) throw new Error('nothing to sell');
  let approveTx: string | null = null;
  const allowance: bigint = await token(tokenAddr).getFunction('allowance')(signer.address, NADFUN.router);
  if (allowance < amount) {
    approveTx = await signer.sendTransaction({ to: tokenAddr, data: tokenAbi.encodeFunctionData('approve', [NADFUN.router, amount]) });
  }
  const expected = await quoteSell(tokenAddr, amount);
  const data = routerAbi.encodeFunctionData('sellToNative', [
    { amountIn: amount, amountOutMin: withSlippage(expected, slippageBps), token: tokenAddr, to: signer.address, deadline: deadline() },
  ]);
  const txHash = await signer.sendTransaction({ to: NADFUN.router, data }, { onHash });
  return { ...(await fillFromReceipt(txHash, 'sell', signer.address)), approveTx };
}
