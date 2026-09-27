import { ethers } from 'ethers';
import { rpc } from '../chain/signer.js';
import { tokenAbi } from '../nadfun/trading.js';
import { getMarket } from '../perpl/context.js';

// Display names for markets: Perpl symbols from its context, Nad.fun tokens
// as $SYMBOL read once from the token contract.
const tokens = new Map<string, string>();
export async function tokenSymbol(address: string): Promise<string> {
  const k = address.toLowerCase();
  if (!tokens.has(k)) {
    const sym: string = await new ethers.Contract(k, tokenAbi, rpc()).getFunction('symbol')().catch(() => '');
    tokens.set(k, sym ? `$${sym}` : `${k.slice(0, 8)}…`);
  }
  return tokens.get(k)!;
}

export async function marketSymbol(venue: 'perpl' | 'nadfun', market: string): Promise<string> {
  if (venue === 'nadfun') return tokenSymbol(market);
  return (await getMarket(Number(market)).catch(() => null))?.symbol ?? `market ${market}`;
}
