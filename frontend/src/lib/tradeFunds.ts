import type { Me, Venue } from './contracts';

export function availableTradeFunds(venue: Venue, balances: Me['balances'], monPriceUsd: number | null, chainId: number | undefined): number | null {
  if (!balances || chainId == null) return null;
  const mainnet = chainId === 143;
  const dollars = balances.walletUsd + (mainnet ? balances.usdcUsd ?? 0 : 0);
  const spareMon = Math.max(0, balances.mon - balances.gasReserveMon - (venue === 'perpl' ? 0.1 : 0));
  const monUsd = spareMon * (monPriceUsd ?? 0);
  if (venue === 'perpl') return (balances.perplMarginUsd ?? 0) + dollars + (mainnet ? monUsd * 0.97 : 0);
  return mainnet ? Math.max(dollars, monUsd) : monUsd;
}
