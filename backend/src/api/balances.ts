import { ethers } from 'ethers';
import { erc20Abi } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import { getExchangeInfo } from '../perpl/context.js';
import { monPriceAusd } from '../prices.js';
import { members } from '../store/members.js';
import { restFor } from '../accounts/lifecycle.js';
import { GAS_RESERVE_WEI, nadPaysWith } from '../venues/nadfun.js';

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
    memesPayWith: nadPaysWith(),
  };
}
