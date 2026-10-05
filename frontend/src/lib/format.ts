export const dollars = (value: number | null | undefined, digits = 2) => value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const percent = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const signedDollars = (value: number) => `${value > 0 ? '+' : ''}${dollars(value)}`;
export const signedMon = (value: number) => `${value > 0 ? '+' : ''}${new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value)} MON`;
// Prices from $67,420.00 down to $0.0000512: cents above $1, significant digits below.
export const price = (value: number | null | undefined) => value == null ? '—' : value >= 1 ? dollars(value) : `$${value.toPrecision(value >= 0.01 ? 4 : 3)}`;
export const compactDollars = (value: number | null | undefined) => value == null ? '—' : `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: value >= 1e9 ? 2 : 1 }).format(value)}`;
export const signedPct = (value: number | null | undefined, digits = 2) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
export const timeAgo = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};
