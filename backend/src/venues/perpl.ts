import { restFor, sessionFor } from '../accounts/lifecycle.js';
import { getExchangeInfo, getMarket, getTicker, maxLeverageHundredths, scale } from '../perpl/context.js';
import { members } from '../store/members.js';
import { closePosition, openPosition, viewPositions } from '../trading/positions.js';
import type { CloseInput, Fill, Holding, OpenInput, VenueAdapter } from './types.js';

// Perpl: orders go over the member's trading session with their Perpl API key.
function accountOf(userId: string): number {
  const id = members.get(userId)?.perplAccountId;
  if (!id) throw new Error(`member ${userId} has no Perpl account`);
  return id;
}

async function mark(marketId: number) {
  const m = await getMarket(marketId);
  const { d } = await getTicker();
  const px = scale.unprice(d[String(marketId)]?.mrk ?? 0, m);
  if (!(px > 0)) throw new Error(`no mark price for ${m.symbol}`);
  return { m, px };
}

export const perpl: VenueAdapter = {
  venue: 'perpl',

  async open(i: OpenInput): Promise<Fill> {
    if (i.side === 'buy') throw new Error('perpl sides are long/short');
    const accountId = accountOf(i.userId);
    const { m, px } = await mark(Number(i.market));
    const step = 10 ** m.config.size_decimals;
    const size = Math.floor((i.notionalAusd / px) * step) / step;
    if (size <= 0) throw new Error(`$${i.notionalAusd} rounds to 0 ${m.symbol}`);
    const order = await openPosition(await sessionFor(i.userId), {
      accountId,
      marketId: m.id,
      side: i.side,
      size,
      leverage: i.leverage ?? 1,
      onRq: (rq) => i.onRef?.({ rq, accountId }),
    });
    const filled = scale.unsize(order.fs, m);
    const fillPx = scale.unprice(order.fp, m);
    return {
      venue: 'perpl',
      market: String(m.id),
      side: i.side,
      sizeRaw: String(order.fs),
      size: filled,
      priceAusd: fillPx,
      notionalAusd: filled * fillPx,
      orderId: order.oid,
      requestId: order.rq,
      txHash: order.at?.txid ?? null,
    };
  },

  async close(i: CloseInput): Promise<Fill> {
    const accountId = accountOf(i.userId);
    const m = await getMarket(Number(i.market));
    const session = await sessionFor(i.userId);
    const pos = session.positions.get(`${accountId}:${m.id}`);
    const order = await closePosition(session, accountId, m.id, {
      sizeScaled: i.sizeRaw != null ? Number(i.sizeRaw) : undefined,
      onRq: (rq) => i.onRef?.({ rq, accountId }),
    });
    const filled = scale.unsize(order.fs, m);
    const fillPx = scale.unprice(order.fp, m);
    return {
      venue: 'perpl',
      market: String(m.id),
      side: pos?.sd === 2 ? 'short' : 'long',
      sizeRaw: String(order.fs),
      size: filled,
      priceAusd: fillPx,
      notionalAusd: filled * fillPx,
      orderId: order.oid,
      requestId: order.rq,
      txHash: order.at?.txid ?? null,
    };
  },

  async holdings(userId: string, markets?: string[]): Promise<Holding[]> {
    if (!members.credentials(userId)) return [];
    const views = await viewPositions((await restFor(userId).positions()).d);
    return views
      .filter((v) => !markets || markets.includes(String(v.marketId)))
      .map((v) => ({
        venue: 'perpl' as const,
        market: String(v.marketId),
        symbol: v.symbol,
        side: v.side,
        sizeRaw: String(Math.round(v.size * 10 ** 12) / 10 ** 12),
        size: v.size,
        entryPriceAusd: v.entryPrice,
        markPriceAusd: v.markPrice,
        valueAusd: v.notionalUsd,
        pnlAusd: v.unrealizedPnlUsd,
        leverage: v.leverage,
      }));
  },

  async freeBalanceAusd(userId: string): Promise<number> {
    const accountId = accountOf(userId);
    const acct = (await sessionFor(userId)).accounts.get(accountId);
    if (!acct) throw new Error(`Perpl session has no account ${accountId}`);
    const { collateralDecimals } = await getExchangeInfo();
    return (Number(acct.b) - Number(acct.lb)) / 10 ** collateralDecimals;
  },

  async markPriceAusd(market: string) {
    return (await mark(Number(market))).px;
  },

  async maxLeverage(market: string) {
    return maxLeverageHundredths(await getMarket(Number(market))) / 100;
  },
};
