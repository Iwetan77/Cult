import { randomUUID } from 'node:crypto';
import { clans } from '../store/clans.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { venue as defaultVenue, type TradeSide, type Venue, type VenueAdapter } from '../venues/index.js';
import { MirrorError } from './engine.js';
import { recordRef } from './origin.js';
import { trades } from './repo.js';

// Manual stack: a member taps someone's marker on the clan chart and opens
// their own position/buy on top of it. It's the member's explicit action,
// sized by them, run once. It shares no code path with auto-mirror: no opt-out
// window, no proportional sizing, no auto-close when the target closes, and it
// is tagged so it never becomes a leader trade that others auto-mirror.
// Same call for both venues; the adapter does the venue-specific part.

export interface StackRequest {
  clanId: string;
  userId: string;
  tradeId: string; // the marker's leader trade
  notionalAusd: number;
  leverage?: number; // perpl only; defaults to the target's leverage
}

export interface StackResult {
  id: string;
  venue: Venue;
  status: 'open' | 'failed';
  market: string;
  side: TradeSide;
  size: number;
  notionalAusd: number;
  leverage: number;
  orderId?: number;
  txHash?: string | null;
  error?: string;
}

export async function stackOnTrade(req: StackRequest, venueOf: (v: Venue) => VenueAdapter = defaultVenue): Promise<StackResult> {
  if (!clans.membership(req.clanId, req.userId)) throw new MirrorError(403, 'not a member of this clan');
  const trade = trades.get(req.tradeId);
  if (!trade || trade.closedAt) throw new MirrorError(404, 'that position is not open');
  if (!clans.membership(req.clanId, trade.userId)) throw new MirrorError(404, 'that position is not in this clan');
  if (trade.userId === req.userId) throw new MirrorError(400, 'cannot stack on your own position');
  if (trade.venue === 'perpl' && !members.get(req.userId)?.perplAccountId) throw new MirrorError(409, 'finish Perpl setup first');

  const adapter = venueOf(trade.venue);
  const leverage = trade.venue === 'perpl' ? Math.min(req.leverage ?? trade.leverage / 100, await adapter.maxLeverage(trade.market)) : 1;

  const id = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO stacks (id, venue, clan_id, user_id, target_trade, market, side, notional_usd, leverage, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?)`,
  ).run(id, trade.venue, req.clanId, req.userId, trade.id, trade.market, trade.side, req.notionalAusd, Math.round(leverage * 100), Date.now());

  try {
    const fill = await adapter.open({
      userId: req.userId,
      market: trade.market,
      side: trade.side,
      notionalAusd: req.notionalAusd,
      leverage,
      onRef: (ref) => {
        recordRef(ref, 'stack_open', id);
        if (ref.rq != null) db.prepare('UPDATE stacks SET open_rq = ? WHERE id = ?').run(ref.rq, id);
      },
    });
    db.prepare(`UPDATE stacks SET status = 'open', size = ?, notional_usd = ?, open_oid = ?, open_tx = ? WHERE id = ?`).run(
      fill.sizeRaw,
      fill.notionalAusd,
      fill.orderId ?? null,
      fill.txHash ?? null,
      id,
    );
    return {
      id,
      venue: trade.venue,
      status: 'open',
      market: trade.market,
      side: trade.side,
      size: fill.size,
      notionalAusd: fill.notionalAusd,
      leverage,
      orderId: fill.orderId,
      txHash: fill.txHash ?? null,
    };
  } catch (e) {
    db.prepare(`UPDATE stacks SET status = 'failed', error = ? WHERE id = ?`).run(String(e).slice(0, 500), id);
    return { id, venue: trade.venue, status: 'failed', market: trade.market, side: trade.side, size: 0, notionalAusd: req.notionalAusd, leverage, error: String(e) };
  }
}
