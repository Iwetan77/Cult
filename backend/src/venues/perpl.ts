import { restFor, sessionFor } from '../accounts/lifecycle.js';
import { getExchangeInfo, getMarket, getTicker, maxLeverageHundredths, scale } from '../perpl/context.js';
import { members } from '../store/members.js';
import { ensurePerplMargin, perplFreeAusd, walletSpendableAusd } from '../funding/margin.js';
import { checkLeverage, closePosition, openPosition, viewPositions } from '../trading/positions.js';
import { readTpSl, type TpSl } from '../trading/tpsl.js';
import type { CloseInput, Fill, Holding, OpenInput, VenueAdapter } from './types.js';
import { PositionSide } from '../perpl/types.js';
import { MirrorError } from '../mirror/engine.js';

// Perpl: orders go over the member's trading session with their Perpl API key.

// A chart load reads each member's positions (holdings) and open orders
// (TP/SL) from Perpl; cache both for a moment so one render doesn't hit
// Perpl's rate limit twice per member. In-flight reads are shared too.
const READ_TTL_MS = 2_000;
const reads = new Map<string, { at: number; p: Promise<unknown> }>();
function cachedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = reads.get(key);
  if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.p as Promise<T>;
  const p = load();
  reads.set(key, { at: Date.now(), p });
  p.catch(() => reads.delete(key)); // don't cache failures
  return p;
}
const positionsOf = (userId: string) => cachedRead(`pos:${userId}`, () => restFor(userId).positions());
const ordersOf = (userId: string) => cachedRead(`ord:${userId}`, () => restFor(userId).openOrders());
// After this process trades for a member, their next read must be fresh.
export function invalidatePerplReads(userId: string) {
  reads.delete(`pos:${userId}`);
  reads.delete(`ord:${userId}`);
}
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
    const leverage = checkLeverage(m, i.leverage ?? 1) / 100;
    const step = 10 ** m.config.size_decimals;
    const size = Math.floor((i.notionalAusd / px) * step) / step;
    if (size <= 0) throw new Error(`$${i.notionalAusd} rounds to 0 ${m.symbol}`);
    const session = await sessionFor(i.userId);
    const checkSide = () => {
      const existing = session.positions.get(`${accountId}:${m.id}`);
      if (existing && existing.s > 0 && (existing.sd === PositionSide.Long ? 'long' : 'short') !== i.side) {
        throw new MirrorError(409, 'Close your existing opposite-side position first. Perpl combines trades on the same asset into one net position.');
      }
    };
    checkSide();
    // Margin for this order plus a little for fees and price moves, moved in
    // from the wallet (AUSD, then MON via Kuru) if the Perpl account is short.
    const notional = size * px;
    await ensurePerplMargin(i.userId, (notional / leverage) * 1.02 + notional * 0.001);
    checkSide(); // Funding can take several blocks; the position may have changed.
    const order = await openPosition(session, {
      accountId,
      marketId: m.id,
      side: i.side,
      size,
      leverage,
      onRq: (rq) => i.onRef?.({ rq, accountId }),
    });
    invalidatePerplReads(i.userId);
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
    if (i.side && pos && (pos.sd === PositionSide.Short ? 'short' : 'long') !== i.side) {
      throw new MirrorError(409, 'The position changed direction. Refresh your positions before closing.');
    }
    const order = await closePosition(session, accountId, m.id, {
      sizeScaled: i.sizeRaw != null ? Number(i.sizeRaw) : undefined,
      onRq: (rq) => i.onRef?.({ rq, accountId }),
    });
    invalidatePerplReads(i.userId);
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
    const raw = (await positionsOf(userId)).d.filter((p) => !markets || markets.includes(String(p.mkt)));
    const views = await viewPositions(raw);
    // sizeRaw is Perpl's scaled integer size, the same unit fills and mirrors record.
    return raw.map((p, i) => {
      const v = views[i]!;
      return {
        venue: 'perpl' as const,
        market: String(p.mkt),
        symbol: v.symbol,
        side: v.side,
        sizeRaw: String(p.s),
        size: v.size,
        entryPriceAusd: v.entryPrice,
        markPriceAusd: v.markPrice,
        valueAusd: v.notionalUsd,
        pnlAusd: v.unrealizedPnlUsd,
        leverage: v.leverage,
      };
    });
  },

  // What a Perpl trade can draw on: free margin in the Perpl account plus what
  // open() can move in from the wallet (AUSD, and MON above the gas reserve).
  async freeBalanceAusd(userId: string): Promise<number> {
    const [account, wallet] = await Promise.all([perplFreeAusd(userId), walletSpendableAusd(userId)]);
    return account + wallet;
  },

  async markPriceAusd(market: string) {
    return (await mark(Number(market))).px;
  },

  async maxLeverage(market: string) {
    return maxLeverageHundredths(await getMarket(Number(market))) / 100;
  },
};

// The member's live TP/SL on a Perpl market, read from Perpl's open orders
// (untriggered trigger orders are listed there). Null legs = not set.
export async function perplTpSl(userId: string, marketId: number): Promise<TpSl | null> {
  if (!members.credentials(userId)) return null;
  const [pos, orders] = await Promise.all([positionsOf(userId), ordersOf(userId)]);
  const p = pos.d.find((x) => x.mkt === marketId);
  if (!p) return null;
  const m = await getMarket(marketId);
  const { takeProfit, stopLoss } = readTpSl(orders.d, marketId, p.sd, m.config.price_decimals);
  return { takeProfit, stopLoss };
}
