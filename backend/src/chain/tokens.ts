import { env } from '../config/env.js';

// Circle USDC on Monad mainnet. Members can deposit it; the backend converts it
// to AUSD (src/funding/usdc.ts). There's no USDC route on testnet.
export const USDC_MAINNET = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

export function usdcAddress(chainId = env.chainId): string | null {
  return chainId === 143 ? USDC_MAINNET : null;
}
