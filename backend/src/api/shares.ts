import { statsFor } from '../indexer/stats.js';
import { strEnv } from '../config/env.js';
import { randomBytes } from 'node:crypto';
import { mirrors, trades } from '../mirror/repo.js';
import { clans } from '../store/clans.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { buildChart, shortName } from './chart.js';

// Shareable result card: public by design, the clan isn't. The snapshot is
// frozen at share time from the same live numbers the chart shows, and the
// public payload never carries clan id, invite code or members. The clan name
// appears only when the member explicitly opted in.

export interface PublicShare {
  id: string;
  traderName: string;
  marketSymbol: string;
  venue: 'perpl' | 'nadfun';
  side: string;
  pnlUsd: number | null; // AUSD
  roiPercent: number | null;
  notionalUsd: number | null; // AUSD
  entryPrice: number | null;
  markPrice: number | null;
  closedAt: string | null;
  sharedAt: string;
  // The sharer's verified record (own trades only), frozen at share time. The
  // card shows it as the proof behind the trade; verified false = not yet.
  traderRecord: { verified: boolean; tradeCount: number; winRate: number | null; realizedPnlUsd: number | null; streak: number };
  includeClan: boolean;
  clanName?: string;
}

export class ShareError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

function clanOfMarker(markerId: string): { clanId: string; tradeId: string } | null {
  const [kind, id] = markerId.split(':', 2);
  if (kind === 'mirror') {
    const m = mirrors.get(id!);
    return m ? { clanId: m.clanId, tradeId: m.tradeId } : null;
  }
  if (kind === 'stack') {
    const s = getDb().prepare('SELECT clan_id, target_trade FROM stacks WHERE id = ?').get(id!) as { clan_id: string; target_trade: string } | undefined;
    return s ? { clanId: s.clan_id, tradeId: s.target_trade } : null;
  }
  if (kind === 'trade') {
    const t = trades.get(id!);
    if (!t) return null;
    const c = clans.forUser(t.userId)[0];
    return c ? { clanId: c.id, tradeId: t.id } : null;
  }
  return null;
}

export async function createShare(userId: string, markerId: string, includeClan: boolean) {
  const where = clanOfMarker(markerId);
  if (!where) throw new ShareError(404, 'marker not found');
  const clan = clans.get(where.clanId)!;
  const trade = trades.get(where.tradeId)!;
  const chart = await buildChart(clan, userId, trade.market);
  const marker = chart.markers.find((m) => m.id === markerId);
  if (!marker) throw new ShareError(404, 'that position is no longer open');
  if (!marker.isMine) throw new ShareError(403, 'you can only share your own trades');

  const cost = marker.entryPrice != null && marker.size != null ? (marker.entryPrice * marker.size) / (marker.leverage || 1) : null;
  const wallet = members.get(userId)!.wallet;
  const rec = (await statsFor([wallet])).get(wallet.toLowerCase())!;
  const snapshot: Omit<PublicShare, 'id' | 'includeClan' | 'clanName'> = {
    traderName: shortName(members.get(userId)!.wallet),
    marketSymbol: chart.selectedMarket.symbol,
    venue: marker.venue,
    side: marker.side,
    pnlUsd: marker.pnlUsd,
    roiPercent: marker.pnlUsd != null && cost ? (marker.pnlUsd / cost) * 100 : null,
    notionalUsd: marker.valueUsd,
    entryPrice: marker.entryPrice,
    markPrice: marker.markPrice,
    closedAt: null,
    sharedAt: new Date().toISOString(),
    traderRecord: { verified: rec.verified, tradeCount: rec.tradeCount, winRate: rec.winRate, realizedPnlUsd: rec.realizedPnlUsd, streak: rec.streak },
  };
  const id = randomBytes(9).toString('base64url');
  getDb()
    .prepare('INSERT INTO shares (id, user_id, marker_id, include_clan, clan_name, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, markerId, includeClan ? 1 : 0, includeClan ? clan.name : null, JSON.stringify(snapshot), Date.now());
  const base = strEnv('PUBLIC_APP_URL', 'http://localhost:3000').replace(/\/$/, '');
  return { id, url: `${base}/share/${id}` };
}

export function getShare(id: string): PublicShare | null {
  const r = getDb().prepare('SELECT * FROM shares WHERE id = ?').get(id) as
    | { id: string; include_clan: number; clan_name: string | null; snapshot: string }
    | undefined;
  if (!r) return null;
  const snap = JSON.parse(r.snapshot);
  return { id: r.id, ...snap, includeClan: r.include_clan === 1, ...(r.include_clan === 1 && r.clan_name ? { clanName: r.clan_name } : {}) };
}
