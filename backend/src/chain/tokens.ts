import { env } from '../config/env.js';

// Circle USDC on Monad mainnet. Members can deposit it; the backend converts it
// to AUSD (src/funding/usdc.ts). There's no USDC route on testnet.
export const USDC_MAINNET = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
// Circle's Monad testnet USDC. Read-only wallet visibility; Kuru Flow's
// mainnet router cannot convert this into Perpl testnet collateral.
export const USDC_TESTNET = '0x534b2f3A21130d7a60830c2Df862319e593943A3';

export function usdcAddress(chainId = env.chainId): string | null {
  return chainId === 143 ? USDC_MAINNET : null;
}
