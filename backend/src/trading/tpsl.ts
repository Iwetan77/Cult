import { getMarket, getTicker, scale } from '../perpl/context.js';
import type { TradingSession } from '../perpl/session.js';
import { OrderFlags, OrderStatus, OrderType, PositionSide, TriggerCondition, type Order, type Position } from '../perpl/types.js';

// Take-profit / stop-loss on a Perpl position, as Perpl's own trigger orders:
// reduce-only Close* orders with a trigger price, linked to the position (lp)
// so Perpl cancels them when the position closes. They fire on the MARK price
// (the testnet context has tpSlTriggerOnMarkPrice on) and execute IOC.
//
// Because a TP/SL closes the leader's position through Perpl, the mirror
// engine sees the close and unwinds followers the same way as a manual exit.

export interface TpSl {
  takeProfit: number | null; // $ price
  stopLoss: number | null;
}

const isTrigger = (o: Order) => (o.tp ?? 0) > 0 && (o.t === OrderType.CloseLong || o.t === OrderType.CloseShort);

// Classify resting triggers on a market for a position of `side`.
export function readTpSl(orders: Order[], marketId: number, side: PositionSide, priceDecimals: number): TpSl & { orderIds: number[] } {
  const out: TpSl & { orderIds: number[] } = { takeProfit: null, stopLoss: null, orderIds: [] };
  for (const o of orders) {
    if (o.mkt !== marketId || !isTrigger(o) || o.r) continue;
    const gte = o.tpc === TriggerCondition.GTEMark || o.tpc === TriggerCondition.GTELast;
    const price = o.tp! / 10 ** priceDecimals;
    // long: price up = take profit; short: price down = take profit
    const isTp = side === PositionSide.Long ? gte : !gte;
    if (isTp) out.takeProfit = price;
    else out.stopLoss = price;
    out.orderIds.push(o.oid);
  }
  return out;
}

export class TpSlError extends Error {}

// Replace the position's TP/SL. `null` removes that leg; `undefined` keeps it.
export async function setTpSl(session: TradingSession, accountId: number, marketId: number, want: Partial<TpSl>): Promise<TpSl> {
  const pos: Position | undefined = session.positions.get(`${accountId}:${marketId}`);
  if (!pos) throw new TpSlError('no open position on that market');
  const m = await getMarket(marketId);
  const { d } = await getTicker();
  const mark = scale.unprice(d[String(marketId)]?.mrk ?? 0, m);
  const long = pos.sd === PositionSide.Long;
  const current = readTpSl([...session.openOrders.values()], marketId, pos.sd, m.config.price_decimals);
  const next: TpSl = {
    takeProfit: want.takeProfit === undefined ? current.takeProfit : want.takeProfit,
    stopLoss: want.stopLoss === undefined ? current.stopLoss : want.stopLoss,
  };
  if (next.takeProfit != null && (long ? next.takeProfit <= mark : next.takeProfit >= mark)) {
    throw new TpSlError(`take-profit must be ${long ? 'above' : 'below'} the mark price ($${mark})`);
  }
  if (next.stopLoss != null && (long ? next.stopLoss >= mark : next.stopLoss <= mark)) {
    throw new TpSlError(`stop-loss must be ${long ? 'below' : 'above'} the mark price ($${mark})`);
  }

  // Cancel the existing triggers first, then place the new pair.
  for (const oid of current.orderIds) {
    const c = await session.placeOrder({ mkt: marketId, acc: accountId, oid, t: OrderType.Cancel, s: 0, fl: OrderFlags.GoodTillCancel, lv: 0, lb: 0 });
    if (c.st === OrderStatus.Failed) throw new TpSlError(`could not cancel trigger ${oid}: sr=${c.sr}`);
  }
  const close = long ? OrderType.CloseLong : OrderType.CloseShort;
  const place = async (price: number, cond: TriggerCondition) => {
    const o = await session.placeOrder({
      mkt: marketId,
      acc: accountId,
      t: close,
      p: 0,
      s: pos.s,
      tp: scale.price(price, m),
      tpc: cond,
      lp: pos.pid,
      fl: OrderFlags.ImmediateOrCancel,
      lv: 0,
      lb: 0,
    });
    if (o.st === OrderStatus.Failed) throw new TpSlError(`trigger rejected: sr=${o.sr} fr=${o.fr ?? '-'}`);
  };
  if (next.takeProfit != null) await place(next.takeProfit, long ? TriggerCondition.GTEMark : TriggerCondition.LTEMark);
  if (next.stopLoss != null) await place(next.stopLoss, long ? TriggerCondition.LTEMark : TriggerCondition.GTEMark);
  return next;
}
