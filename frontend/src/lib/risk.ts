// Liquidation, estimated. Perpl liquidates a position when its margin falls to
// the market's maintenance margin. The backend doesn't send that rate yet, so
// this assumes the common convention: half the initial margin at the market's
// max leverage (so 1% for a 50x market). Shown as an estimate everywhere.

export const maintenanceRate = (maxLeverage: number) => 1 / (2 * Math.max(1, maxLeverage));

// How far the price can move against the position before it is liquidated, as
// a fraction of the entry (0.018 = 1.8%). Null when it can't be liquidated.
export function liquidationMove(leverage: number, maxLeverage: number): number | null {
  const move = 1 / Math.max(1, leverage) - maintenanceRate(maxLeverage);
  return move > 0 ? move : null;
}

export function liquidationPrice(entry: number, side: 'long' | 'short' | 'buy', leverage: number, maxLeverage: number): number | null {
  if (side === 'buy' || !(entry > 0)) return null;
  const move = liquidationMove(leverage, maxLeverage);
  if (move == null) return null;
  return side === 'short' ? entry * (1 + move) : entry * (1 - move);
}

// Above this, the ticket asks you to confirm before opening.
export const HIGH_LEVERAGE = 20;
