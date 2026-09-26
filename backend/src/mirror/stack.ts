import { randomUUID } from 'node:crypto';
import { getMarket, getTicker, maxLeverageHundredths, scale } from '../perpl/context.js';
import type { TradingSession } from '../perpl/session.js';
import { clans } from '../store/clans.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { openPosition } from '../trading/positions.js';
import { MirrorError } from './engine.js';
import { recordEngineOrder } from './origin.js';
import { trades } from './repo.js';

// Manual stack: a member taps someone's marker on the clan chart and opens
// their own position on top of it. This is the member's explicit action, sized
// by them, run once. It shares no code path with auto-mirror: no opt-out
// window, no proportional sizing, no auto-close when the target closes, and it
// is tagged so it never becomes a leader trade that others auto-mirror.

export interface StackRequest {
  clanId: string;
  userId: string;
  tradeId: string; // the marker's leader trade
  notionalUsd: number;
  leverage?: number; // defaults to the target's leverage
}

export interface StackResult {
  id: string;
  status: 'open' | 'failed';
  marketId: number;
  side: 'long' | 'short';
  size: number;
  notionalUsd: number;
  leverage: number;
  orderId?: number;
  txHash?: string | null;
  error?: string;
}

export async function stackOnTrade(req: StackRequest, sessionFor: (userId: string) => Promise<TradingSession>): Promise<StackResult> {
  if (!clans.membership(req.clanId, req.userId)) throw new MirrorError(403, 'not a member of this clan');
  const trade = trades.get(req.tradeId);
  if (!trade || trade.closedAt) throw new MirrorError(404, 'that position is not open');
  if (!clans.membership(req.clanId, trade.userId)) throw new MirrorError(404, 'that position is not in this clan');
  if (trade.userId === req.userId) throw new MirrorError(400, 'cannot stack on your own position');
  const me = members.get(req.userId);
  if (!me?.perplAccountId) throw new MirrorError(409, 'finish Perpl setup first');

  const market = await getMarket(trade.marketId);
  const maxLev = maxLeverageHundredths(market) / 100;
  const leverage = Math.min(req.leverage ?? trade.leverage / 100, maxLev);
  const { d } = await getTicker();
  const mark = scale.unprice(d[String(market.id)]?.mrk ?? 0, market);
  if (!mark) throw new MirrorError(503, 'no mark price');
  const sizeScaled = Math.floor((req.notionalUsd / mark) * 10 ** market.config.size_decimals);
  if (sizeScaled <= 0) throw new MirrorError(400, 'size rounds to zero');
  const size = sizeScaled / 10 ** market.config.size_decimals;

  const id = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO stacks (id, clan_id, user_id, target_trade, market_id, side, notional_usd, leverage, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?)`,
  ).run(id, req.clanId, req.userId, trade.id, market.id, trade.side, size * mark, Math.round(leverage * 100), Date.now());

  const session = await sessionFor(req.userId);
  try {
    const order = await openPosition(session, {
      accountId: me.perplAccountId,
      marketId: market.id,
      side: trade.side,
      size,
      leverage,
      onRq: (rq) => {
        recordEngineOrder(me.perplAccountId!, rq, 'stack_open', id);
        db.prepare('UPDATE stacks SET open_rq = ? WHERE id = ?').run(rq, id);
      },
    });
    db.prepare(`UPDATE stacks SET status = 'open', size = ?, open_oid = ?, open_tx = ? WHERE id = ?`).run(
      order.fs,
      order.oid,
      order.at?.txid ?? null,
      id,
    );
    return {
      id,
      status: 'open',
      marketId: market.id,
      side: trade.side,
      size: order.fs / 10 ** market.config.size_decimals,
      notionalUsd: size * mark,
      leverage,
      orderId: order.oid,
      txHash: order.at?.txid ?? null,
    };
  } catch (e) {
    db.prepare(`UPDATE stacks SET status = 'failed', error = ? WHERE id = ?`).run(String(e).slice(0, 500), id);
    return { id, status: 'failed', marketId: market.id, side: trade.side, size, notionalUsd: size * mark, leverage, error: String(e) };
  }
}
