import { ethers } from 'ethers';
import { rpc } from '../chain/signer.js';

// Kuru AUSD/USDC order book on Monad mainnet (the only network it exists on;
// see CONTRACTS.md, blocker 1). base = AUSD, quote = USDC, both 6 decimals,
// 0 fees. USDC -> AUSD is a market BUY of the base with quote.
export const KURU_AUSD_USDC = '0x8cf49e35d73b19433ff4d4421637aabb680dc9cc';

export const orderBookAbi = new ethers.Interface([
  'function getMarketParams() view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAsset, uint256 baseAssetDecimals, address quoteAsset, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)',
  'function bestBidAsk() view returns (uint256, uint256)',
  'function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)',
]);

export interface KuruMarket {
  address: string;
  pricePrecision: bigint;
  baseAsset: string; // AUSD
  baseDecimals: number;
  quoteAsset: string; // USDC
  quoteDecimals: number;
  hasAsks: boolean;
}

export async function kuruMarket(address = KURU_AUSD_USDC): Promise<KuruMarket> {
  const c = new ethers.Contract(address, orderBookAbi, rpc());
  const p = await c.getFunction('getMarketParams')();
  const [, ask] = (await c.getFunction('bestBidAsk')()) as [bigint, bigint];
  return {
    address,
    pricePrecision: BigInt(p[0]),
    baseAsset: p[2],
    baseDecimals: Number(p[3]),
    quoteAsset: p[4],
    quoteDecimals: Number(p[5]),
    // Empty ask side = nothing to buy AUSD from (bestBidAsk sentinels).
    hasAsks: ask !== 0n && ask !== ethers.MaxUint256,
  };
}

// Calldata for a fill-or-kill market buy spending exactly `usdcIn` (raw, 6dp)
// and refusing to fill for less than `minAusdOut` (raw, 6dp). FOK so a thin
// book can't leave a member half-swapped.
export function marketBuyCalldata(m: KuruMarket, usdcIn: bigint, minAusdOut: bigint): string {
  // _quoteSize is expressed in pricePrecision units, not token decimals.
  const quoteSize = (usdcIn * m.pricePrecision) / 10n ** BigInt(m.quoteDecimals);
  return orderBookAbi.encodeFunctionData('placeAndExecuteMarketBuy', [quoteSize, minAusdOut, false, true]);
}
