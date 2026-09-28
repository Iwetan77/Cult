import { ethers } from 'ethers';
import { erc20Abi } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import { getExchangeInfo } from '../perpl/context.js';
import { monPriceAusd } from '../prices.js';
import { members } from '../store/members.js';
import { restFor } from '../accounts/lifecycle.js';
import { GAS_RESERVE_WEI, memesPayWithFor, nadPaysWith } from '../venues/nadfun.js';

// A member's dollars sit in two pockets: Perpl margin (perps) and wallet AUSD
// (memes, when they're paid in dollars). Plus MON for gas. All values in $;
// null when a pocket doesn't exist yet (e.g. no Perpl account).
export interface Balances {
  perplMarginUsd: number | null; // free margin in their Perpl account
  walletUsd: number; // AUSD sitting in the wallet
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
  return {
    perplMarginUsd,
    walletUsd: Number(ethers.formatUnits(walletRaw, collateralDecimals)),
    mon,
    monUsd: monPx != null ? mon * monPx : null,
    gasReserveMon: Number(ethers.formatEther(GAS_RESERVE_WEI)),
    lowGas: monWei < GAS_RESERVE_WEI,
    memesPayWith: await memesPayWithFor(userId).catch(() => nadPaysWith()),
  };
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
  balance: number;
  balanceUsd: number | null;
}

export interface DepositInfo {
  address: string;
  network: { name: string; chainId: number };
  tokens: DepositToken[];
  tradingAccountUsd: number | null; // dollars already in the Perpl account
  totalUsd: number | null; // everything above, in $
}

export async function depositInfo(userId: string): Promise<DepositInfo> {
  const { env } = await import('../config/env.js');
  const { USDC_MAINNET } = await import('../funding/plan.js');
  const m = members.get(userId);
  if (!m) throw new Error('unknown member');
  const b = await balancesFor(userId);
  const tokens: DepositToken[] = [
    { symbol: 'MON', name: 'Monad', what: 'Trade with it directly: perps swap it to dollars for you. Keep a little for fees.', balance: b.mon, balanceUsd: b.monUsd },
    { symbol: 'AUSD', name: 'Dollars (AUSD)', what: 'Your trading dollars, 1:1 with USD.', balance: b.walletUsd, balanceUsd: b.walletUsd },
  ];
  if (env.chainId === 143) {
    const raw: bigint = await new ethers.Contract(USDC_MAINNET, erc20Abi, rpc()).getFunction('balanceOf')(m.wallet).catch(() => 0n);
    const usdc = Number(ethers.formatUnits(raw, 6));
    tokens.splice(1, 0, { symbol: 'USDC', name: 'USD Coin', what: 'Turned into dollars (AUSD) automatically, within a minute.', balance: usdc, balanceUsd: usdc });
  }
  const parts = [...tokens.map((t) => t.balanceUsd), b.perplMarginUsd ?? 0];
  return {
    address: ethers.getAddress(m.wallet),
    network: { name: env.chainId === 143 ? 'Monad' : 'Monad testnet', chainId: env.chainId },
    tokens,
    tradingAccountUsd: b.perplMarginUsd,
    totalUsd: parts.some((x) => x == null) ? null : parts.reduce((a, x) => a! + x!, 0),
  };
}
