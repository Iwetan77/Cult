import { ethers } from 'ethers';
import { numEnv } from '../config/env.js';
import { signerFor } from '../accounts/signers.js';
import { erc20Abi } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import { usdcAddress } from '../chain/tokens.js';
import { getExchangeInfo } from '../perpl/context.js';
import { backendSignerStatus } from '../privy/policy.js';
import { members } from '../store/members.js';
import { swap } from '../swap/kuruFlow.js';

// Deposited USDC becomes dollars (AUSD) by itself. Every USDC_POLL_SECONDS the
// backend reads members' USDC on mainnet; anything from USDC_MIN_CONVERT up is
// swapped to AUSD through Kuru Flow (routed via the deep AUSD/USDC pool),
// signed under the member's Privy policy, which allows exactly this: USDC in,
// AUSD out to the member, capped per transaction, no fees. More than the cap
// converts over a few rounds.
//
// Needs the member's backend signer attached under the current rules. Until
// then their USDC waits in the wallet, untouched.

export interface Conversion {
  usdc: number;
  ausd: number;
  tx: string;
  at: number;
}

const recent = new Map<string, Conversion>(); // userId -> last conversion
const busy = new Set<string>();
const backoff = new Map<string, number>(); // userId -> retry after (ms)
const holds = new Map<string, number>(); // userId -> leave their USDC alone until (ms)

// A cross-chain withdrawal swaps AUSD to USDC and sends the USDC on: leave
// that USDC where it is meanwhile instead of turning it back into AUSD.
export function holdUsdc(userId: string, ms = 15 * 60_000) {
  holds.set(userId, Date.now() + ms);
}

// The member's last conversion, if it was in the last 10 minutes (for a
// "your USDC is now $X" note in the app).
export function recentConversion(userId: string): Conversion | null {
  const c = recent.get(userId);
  return c && Date.now() - c.at < 10 * 60_000 ? c : null;
}

// USDC sitting in a member's wallet, in $ (mainnet; 0 where there's none).
export async function usdcUsd(wallet: string): Promise<number> {
  const usdc = usdcAddress();
  if (!usdc) return 0;
  const bal: bigint = await new ethers.Contract(usdc, erc20Abi, rpc()).getFunction('balanceOf')(wallet).catch(() => 0n);
  return Number(ethers.formatUnits(bal, 6));
}

// A trade that's short on AUSD: turn the member's USDC into AUSD now instead
// of waiting for the next sweep (needs their trading permission, like the
// sweep). Best effort: the trade then reads balances again.
export async function convertUsdcNow(userId: string): Promise<Conversion | null> {
  const m = members.get(userId);
  if (!m || (await usdcUsd(m.wallet)) < numEnv('USDC_MIN_CONVERT', 1)) return null;
  return convertUsdc(userId).catch((e) => { console.warn(`[usdc] on-demand conversion for ${m.wallet} failed: ${(e as Error).message}`); return null; });
}

export async function convertUsdc(userId: string): Promise<Conversion | null> {
  const usdc = usdcAddress();
  const m = members.get(userId);
  if (!usdc || !m?.privyWalletId || busy.has(userId)) return null;
  if ((holds.get(userId) ?? 0) > Date.now()) return null;
  busy.add(userId);
  try {
    const bal: bigint = await new ethers.Contract(usdc, erc20Abi, rpc()).getFunction('balanceOf')(m.wallet);
    const min = BigInt(Math.round(numEnv('USDC_MIN_CONVERT', 1) * 1e6));
    if (bal < min) return null;
    const status = await backendSignerStatus(userId);
    const policy = members.privyPolicy(userId);
    if (!status.attached || !status.policyCurrent || !policy) return null;
    const amount = bal < policy.capRaw ? bal : policy.capRaw;
    const { collateralToken, collateralDecimals } = await getExchangeInfo();
    const fill = await swap(signerFor(userId), usdc, collateralToken, amount, { slippageBps: numEnv('FUNDING_SLIPPAGE_BPS', 30) });
    const c: Conversion = {
      usdc: Number(ethers.formatUnits(amount, 6)),
      ausd: Number(ethers.formatUnits(fill.received, collateralDecimals)),
      tx: fill.txHash,
      at: Date.now(),
    };
    recent.set(userId, c);
    backoff.delete(userId);
    console.log(`[usdc] ${m.wallet}: ${c.usdc} USDC -> ${c.ausd} AUSD (${c.tx})`);
    return c;
  } finally {
    busy.delete(userId);
  }
}

async function sweep() {
  for (const m of members.all()) {
    if (Date.now() < (backoff.get(m.userId) ?? 0)) continue;
    await convertUsdc(m.userId).catch((e) => {
      backoff.set(m.userId, Date.now() + 5 * 60_000);
      console.warn(`[usdc] ${m.wallet}: conversion failed, retrying in 5 min: ${(e as Error).message}`);
    });
  }
}

export function startUsdcConversion(): () => void {
  if (!usdcAddress()) return () => undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async () => {
    await sweep().catch((e) => console.warn('[usdc] sweep:', (e as Error).message));
    if (!stopped) timer = setTimeout(loop, numEnv('USDC_POLL_SECONDS', 20) * 1000);
  };
  void loop();
  console.log('[usdc] converting deposited USDC to AUSD');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
