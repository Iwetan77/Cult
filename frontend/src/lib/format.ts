export const ausd = (value: number | null | undefined, digits = 2) => value == null ? '—' : `${new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} AUSD`;
export const mon = (value: number | null | undefined) => value == null ? '—' : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value)} MON`;
export const percent = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const signedAusd = (value: number) => `${value > 0 ? '+' : ''}${ausd(value)}`;