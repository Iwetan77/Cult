export const usd = (value: number | null | undefined, digits = 2) => value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const percent = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const signedUsd = (value: number) => `${value > 0 ? '+' : ''}${usd(value)}`;
