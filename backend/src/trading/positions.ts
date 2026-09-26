import { getExchangeInfo, getMarket, getTicker, maxLeverageHundredths, scale } from '../perpl/context.js';
import type { TradingSession } from '../perpl/session.js';
import { OrderFlags, OrderStatus, OrderType, PositionSide, type Market, type Order, type Position } from '../perpl/types.js';

export type Side = 'long' | 'short';

export interface OpenParams {
  accountId: number;
  marketId: number;
  side: Side;
  size: number; // human units of the market's base asset, e.g. 0.001 BTC
  leverage: number; // e.g. 5 for 5x
  maxSlippageBps?: number;
  onRq?: (rq: number) => void;
}

export class OrderFailed extends Error {
  constructor(readonly order: Order) {
    super(`order rq=${order.rq} failed: st=${order.st} sr=${order.sr} fr=${order.fr ?? '-'}`);
  }
}

function checkLeverage(m: Market, leverage: number): number {
  const lv = Math.round(leverage * 100);
  const max = maxLeverageHundredths(m);
  if (lv < 100 || lv > max) throw new Error(`leverage ${leverage}x outside 1x..${max / 100}x for ${m.symbol}`);
  return lv;
}

// Market order as IOC: fills what it can at up to ms bps from mark, cancels the rest.
export async function openPosition(session: TradingSession, p: OpenParams): Promise<Order> {
  const m = await getMarket(p.marketId);
  const s = scale.size(p.size, m);
  if (s <= 0) throw new Error(`size ${p.size} rounds to 0 at ${m.config.size_decimals} decimals`);
  const order = await session.placeOrder({
    mkt: m.id,
    acc: p.accountId,
    t: p.side === 'long' ? OrderType.OpenLong : OrderType.OpenShort,
    p: 0,
    s,
    fl: OrderFlags.ImmediateOrCancel,
    lv: checkLeverage(m, p.leverage),
    ...(p.maxSlippageBps != null ? { ms: p.maxSlippageBps } : {}),
  }, { onRq: p.onRq });
  if (order.st === OrderStatus.Failed || order.fs === 0) throw new OrderFailed(order);
  return order;
}

// Closes the position, or just `sizeScaled` of it when given (a mirror only
// unwinds its own slice if the member also holds size on that market; Perpl
// nets positions per account per market). Close* is reduce-only and clamped.
export async function closePosition(
  session: TradingSession,
  accountId: number,
  marketId: number,
  opts: { sizeScaled?: number; onRq?: (rq: number) => void } = {},
): Promise<Order> {
  const pos = session.positions.get(`${accountId}:${marketId}`);
  if (!pos) throw new Error(`no open position on acc ${accountId} mkt ${marketId}`);
  const order = await session.placeOrder({
    mkt: marketId,
    acc: accountId,
    t: pos.sd === PositionSide.Long ? OrderType.CloseLong : OrderType.CloseShort,
    p: 0,
    s: Math.min(opts.sizeScaled ?? pos.s, pos.s),
    fl: OrderFlags.ImmediateOrCancel,
    lv: pos.lv,
  }, { onRq: opts.onRq });
  if (order.st === OrderStatus.Failed || order.fs === 0) throw new OrderFailed(order);
  return order;
}

export interface PositionView {
  accountId: number;
  marketId: number;
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  collateralUsd: number;
  notionalUsd: number;
  unrealizedPnlUsd: number; // price PnL vs mark, before closing fee and unsettled funding
  entryFeesUsd: number;
  openedAtBlock?: number;
  openTx?: string;
}

// Turns raw Perpl positions into human numbers against the live mark price.
export async function viewPositions(positions: Position[]): Promise<PositionView[]> {
  if (positions.length === 0) return [];
  const [{ d: states }, { collateralDecimals }] = await Promise.all([getTicker(), getExchangeInfo()]);
  const cUnit = 10 ** collateralDecimals;
  return Promise.all(
    positions.map(async (p) => {
      const m = await getMarket(p.mkt);
      const mark = scale.unprice(states[String(p.mkt)]?.mrk ?? 0, m);
      const entry = scale.unprice(p.ep, m);
      const size = scale.unsize(p.s, m);
      const dir = p.sd === PositionSide.Long ? 1 : -1;
      return {
        accountId: p.acc,
        marketId: p.mkt,
        symbol: m.symbol,
        side: p.sd === PositionSide.Long ? 'long' : 'short',
        size,
        entryPrice: entry,
        markPrice: mark,
        leverage: p.lv / 100,
        collateralUsd: Number(p.c) / cUnit,
        notionalUsd: size * mark,
        unrealizedPnlUsd: dir * (mark - entry) * size,
        entryFeesUsd: Number(p.fee) / cUnit,
        openedAtBlock: p.ots?.b,
        openTx: p.ots?.txid,
      } satisfies PositionView;
    }),
  );
}

// Size (human units) that puts `marginUsd` of collateral to work at `leverage`.
export async function sizeForMargin(marketId: number, marginUsd: number, leverage: number): Promise<number> {
  const m = await getMarket(marketId);
  const { d } = await getTicker();
  const mark = scale.unprice(d[String(marketId)]?.mrk ?? 0, m);
  if (!mark) throw new Error(`no mark price for ${m.symbol}`);
  const raw = (marginUsd * leverage) / mark;
  const step = 10 ** -m.config.size_decimals;
  return Math.floor(raw / step) * step;
}
