const logoPaths: Record<string, string> = {
  BTC: '/logos/btc.svg',
  ETH: '/logos/eth.svg',
  SOL: '/logos/sol.svg',
  MON: '/logos/mon.png',
  ZEC: '/logos/zec.svg',
  LIT: '/logos/lit.png',
  PUMP: '/logos/pump.jpg',
  HYPE: '/logos/hype.jpg',
  VVV: '/logos/vvv.png',
  AUSD: '/logos/ausd.png',
  USDC: '/logos/usdc.svg',
};

export function logoFor(symbol: string, imageUri?: string | null): string | null {
  if (imageUri) return imageUri;
  const key = symbol.replace(/-PERP$/i, '').replace(/^\$/, '').toUpperCase();
  return logoPaths[key] ?? null;
}
