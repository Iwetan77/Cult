import { getMarketBySymbol, getTicker, scale } from './perpl/context.js';

// MON priced in AUSD from Perpl's own MON perp mark, the one price source
// the stack already trusts. Used to show Nad.fun values in AUSD and to turn
// AUSD caps into MON for Nad.fun buys. Cached briefly; it's a display/cap
// input, not a settlement price.
let cached: { at: number; px: number } | undefined;

export async function monPriceAusd(): Promise<number> {
  if (cached && Date.now() - cached.at < 15_000) return cached.px;
  const m = await getMarketBySymbol('MON');
  const { d } = await getTicker();
  const px = scale.unprice(d[String(m.id)]?.mrk ?? 0, m);
  if (!(px > 0)) throw new Error('no MON mark price from Perpl');
  cached = { at: Date.now(), px };
  return px;
}
