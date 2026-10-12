import { scale, maxLeverageHundredths } from '../perpl/context.js';
import { PositionSide, type Market, type Position } from '../perpl/types.js';
import { UnderwaterError } from '../funding/errors.js';

// Perpl checks the whole position against the market's initial margin when
// it grows: fair value (collateral + unrealized PnL) >= notional / max
// leverage. A position that's down can fail that even when the add brings its
// own margin at max leverage (sr=44 fr=2, InsufficientCollateralIncrease).
// Using max leverage gives the smallest requirement Perpl could apply, so this
// only refuses orders Perpl would refuse too, and nothing is sent.
export function checkAddMargin(existing: Position | undefined, m: Market, px: number, notional: number, leverage: number, collateralDecimals: number) {
  if (!existing || !(existing.s > 0)) return;
  const held = scale.unsize(existing.s, m);
  const entry = scale.unprice(existing.ep, m);
  const dir = existing.sd === PositionSide.Short ? -1 : 1;
  const upnl = dir * (px - entry) * held;
  const fairValue = Number(existing.c) / 10 ** collateralDecimals + upnl;
  const maxLeverage = maxLeverageHundredths(m) / 100;
  const need = ((held * Math.max(px, entry) + notional) / maxLeverage) * 1.01 - fairValue;
  const brings = notional / leverage;
  if (!Number.isFinite(need) || need <= brings) return; // unknown collateral or entry: let Perpl decide
  const name = m.symbol || m.name || 'this market';
  const down = upnl < 0 ? ` is down $${(-upnl).toFixed(2)}, so adding to it` : ' is near its margin limit, so adding to it';
  throw new UnderwaterError(
    `Your ${name} position${down} needs about $${need.toFixed(2)} of margin, and this trade brings $${brings.toFixed(2)}. Lower the leverage, use a bigger amount, or close that position first.`,
  );
}

