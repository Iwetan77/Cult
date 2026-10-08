import { ethers } from 'ethers';
import { erc20Abi } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import { getExchangeInfo } from '../perpl/context.js';
import { monPriceAusd } from '../prices.js';
import { members } from '../store/members.js';
import { restFor } from '../accounts/lifecycle.js';
import { GAS_RESERVE_WEI, memesPayWithFor, nadPaysWith } from '../venues/nadfun.js';

// A member's dollars sit in three pockets: Perpl margin (perps), wallet AUSD
// (memes, when they're paid in dollars) and their Polymarket account
// (predictions, on Polygon). Plus MON for gas. The app shows them as one
// balance. All values in $; null when a pocket doesn't exist yet.
export interface Balances {
  perplMarginUsd: number | null; // free margin in their Perpl account
  walletUsd: number; // AUSD sitting in the wallet
  predictionsUsd: number | null; // pUSD in their Polymarket account
  usdcUsd: number | null; // USDC in the wallet (mainnet), turned into AUSD by itself
  mon: number; // native MON in the wallet
  monUsd: number | null;
  gasReserveMon: number; // never spent by the backend
  lowGas: boolean; // less MON than the reserve: they can't sign or be mirrored on Nad.fun
  memesPayWith: 'ausd' | 'mon';
}

export async function balancesFor(userId: string): Promise<Balances> {
  const m = members.get(userId);
  if (!m) throw new Error('unknown member');
  const { collateralToken, collateralDecimals } = await getExchangeInfo();
  const [walletRaw, monWei, monPx] = await Promise.all([
    new ethers.Contract(collateralToken, erc20Abi, rpc()).getFunction('balanceOf')(m.wallet) as Promise<bigint>,
    rpc().getBalance(m.wallet),
    monPriceAusd().catch(() => null),
  ]);
  let perplMarginUsd: number | null = null;
  if (m.perplAccountId && members.credentials(userId)) {
    const w = await restFor(userId).wallet().catch(() => null);
    const a = w?.as?.find((x) => x.id === m.perplAccountId);
    if (a) perplMarginUsd = (Number(a.b) - Number(a.lb)) / 10 ** collateralDecimals;
  }
  const mon = Number(ethers.formatEther(monWei));
  const predictionsUsd = await predictionsBalance(userId);
  const { usdcAddress } = await import('../chain/tokens.js');
  const { usdcUsd } = await import('../funding/usdc.js');
  const usdc = usdcAddress() ? await usdcUsd(m.wallet) : null;
  return {
    perplMarginUsd,
    walletUsd: Number(ethers.formatUnits(walletRaw, collateralDecimals)),
    predictionsUsd,
    usdcUsd: usdc,
    mon,
    monUsd: monPx != null ? mon * monPx : null,
    gasReserveMon: Number(ethers.formatEther(GAS_RESERVE_WEI)),
    lowGas: monWei < GAS_RESERVE_WEI,
    memesPayWith: await memesPayWithFor(userId).catch(() => nadPaysWith()),
  };
}

// The member's Polymarket balance, when they've opened one (cached a few
// seconds by pusdBalance; Polygon RPC trouble shows as null, not an error).
async function predictionsBalance(userId: string): Promise<number | null> {
  const { predictionAccounts } = await import('../polymarket/store.js');
  const acct = predictionAccounts.get(userId);
  if (!acct?.deployed) return null;
  const { pusdBalance } = await import('../polymarket/account.js');
  return pusdBalance(acct.depositWallet).catch(() => null);
}

// "Deposit": one address, the tokens you can send to it, and what you hold of
// each. Nothing to sign, no contract addresses to copy: send MON, USDC or
// AUSD on Monad to your own address. The app converts to dollars when it
// needs to (USDC -> AUSD through Kuru on mainnet), and the trading account on
// Perpl is filled from wallet dollars when you trade perps.
export interface DepositToken {
  symbol: 'MON' | 'USDC' | 'AUSD';
  name: string;
  what: string; // one line for the UI
  balance: number | null; // null if the token balance could not be read
  balanceUsd: number | null;
  depositSupported: boolean; // false = visible in the wallet, not usable for funding
}

export interface DepositInfo {
  address: string;
  network: { name: string; chainId: number };
  tokens: DepositToken[];
  tradingAccountUsd: number | null; // dollars already in the Perpl account
  totalUsd: number | null; // everything above, in $
}

export function monDepositDescription(chainId: number): string {
  return chainId === 143
    ? 'Trade with it directly: perps swap it to dollars for you. Keep a little for fees.'
    : 'Pays network fees and supported meme buys. Testnet MON cannot be swapped into perps dollars.';
}

export function depositTokensFor(b: Pick<Balances, 'mon' | 'monUsd' | 'walletUsd'>, chainId: number, usdc: number | null): DepositToken[] {
  const mainnet = chainId === 143;
  return [
    { symbol: 'MON', name: 'Monad', what: monDepositDescription(chainId), balance: b.mon, balanceUsd: b.monUsd, depositSupported: true },
    { symbol: 'USDC', name: mainnet ? 'USD Coin' : 'USD Coin (testnet)', what: mainnet ? 'Turned into dollars (AUSD) automatically, within a minute.' : 'Held in your wallet, but cannot be converted into Perpl trading dollars on testnet.', balance: usdc, balanceUsd: mainnet ? usdc : null, depositSupported: mainnet },
    { symbol: 'AUSD', name: 'Dollars (AUSD)', what: 'Your trading dollars, 1:1 with USD.', balance: b.walletUsd, balanceUsd: b.walletUsd, depositSupported: true },
  ];
}

export function depositTotalUsd(tokens: DepositToken[], tradingAccountUsd: number | null): number | null {
  const parts = [...tokens.filter(token => token.depositSupported).map(token => token.balanceUsd), tradingAccountUsd ?? 0];
  return parts.some(value => value == null) ? null : parts.reduce<number>((total, value) => total + value!, 0);
}

export async function depositInfo(userId: string): Promise<DepositInfo> {
  const { env } = await import('../config/env.js');
  const { USDC_MAINNET, USDC_TESTNET } = await import('../chain/tokens.js');
  const m = members.get(userId);
  if (!m) throw new Error('unknown member');
  const b = await balancesFor(userId);
  const usdcToken = env.chainId === 143 ? USDC_MAINNET : USDC_TESTNET;
  const raw: bigint | null = await new ethers.Contract(usdcToken, erc20Abi, rpc()).getFunction('balanceOf')(m.wallet).catch(() => null);
  const usdc = raw == null ? null : Number(ethers.formatUnits(raw, 6));
  const tokens = depositTokensFor(b, env.chainId, usdc);
  return {
    address: ethers.getAddress(m.wallet),
    network: { name: env.chainId === 143 ? 'Monad' : 'Monad testnet', chainId: env.chainId },
    tokens,
    tradingAccountUsd: b.perplMarginUsd,
    totalUsd: depositTotalUsd(tokens, b.perplMarginUsd),
  };
}
