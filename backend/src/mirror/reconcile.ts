import { ethers } from 'ethers';
import { restFor } from '../accounts/lifecycle.js';
import { rpc } from '../chain/signer.js';
import { NADFUN } from '../nadfun/constants.js';
import { routerAbi } from '../nadfun/trading.js';
import { getMarket, scale } from '../perpl/context.js';
import { monPriceAusd } from '../prices.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { KURU_FLOW_ROUTER } from '../swap/kuruFlow.js';
import type { Venue } from '../venues/types.js';
import type { EngineOrderKind } from './origin.js';

// After a crash, what did an order or tx the engine had tagged actually do?
// Read back from the venue by the refs recorded before anything left:
// engine_txs (Nad.fun tx hashes) and engine_orders (Perpl account + request id).
export type Landed =
  | { state: 'filled'; sizeRaw: string; notionalUsd: number; txHash: string | null; orderId: number | null }
  | { state: 'pending' } // still in flight; look again shortly
  | { state: 'failed'; reason: string } // reached the venue but didn't fill
  | { state: 'none' }; // nothing reached the venue

export type LandedLookup = (venue: Venue, kind: EngineOrderKind, refId: string, userId: string) => Promise<Landed>;

export const landed: LandedLookup = (venue, kind, refId, userId) =>
  venue === 'nadfun' ? nadLanded(kind, refId, userId) : perplLanded(kind, refId, userId);

const BUYS: EngineOrderKind[] = ['mirror_open', 'mirror_add', 'stack_open'];

async function nadLanded(kind: EngineOrderKind, refId: string, userId: string): Promise<Landed> {
  const wallet = members.get(userId)?.wallet?.toLowerCase();
  if (!wallet) return { state: 'failed', reason: 'unknown member' };
  const hashes = (getDb().prepare('SELECT tx_hash FROM engine_txs WHERE ref_id = ? AND kind = ? ORDER BY created_at').all(refId, kind) as { tx_hash: string }[]).map((r) => r.tx_hash);
  if (hashes.length === 0) return { state: 'none' };
  const want = BUYS.includes(kind) ? 'Buy' : 'Sell';
  let pending = false;
  let swapped = false;
  let reverted: string | null = null;
  for (const h of hashes) {
    const receipt = await rpc().getTransactionReceipt(h);
    if (!receipt) {
      if (await rpc().getTransaction(h)) pending = true; // else signed but never broadcast
      continue;
    }
    if (receipt.status === 0) {
      reverted = h;
      continue;
    }
    for (const log of receipt.logs) {
      const addr = log.address.toLowerCase();
      if (addr === KURU_FLOW_ROUTER.toLowerCase()) swapped = true;
      if (addr !== NADFUN.router.toLowerCase()) continue;
      const ev = routerAbi.parseLog(log);
      if (ev?.name !== want || (ev.args[0] as string).toLowerCase() !== wallet) continue;
      // Buy(buyer, token, amountIn MON, amountOut tokens) / Sell(seller, token, amountIn tokens, amountOut MON)
      const [tokens, mon] = want === 'Buy' ? [ev.args[3] as bigint, ev.args[2] as bigint] : [ev.args[2] as bigint, ev.args[3] as bigint];
      return { state: 'filled', sizeRaw: tokens.toString(), notionalUsd: Number(ethers.formatEther(mon)) * (await monPriceAusd()), txHash: h, orderId: null };
    }
  }
  if (pending) return { state: 'pending' };
  // Paying in dollars: the AUSD -> MON swap landed but the buy didn't.
  if (swapped && want === 'Buy') return { state: 'failed', reason: "swapped to MON but the meme buy didn't land; the MON is in the member's wallet" };
  if (reverted) return { state: 'failed', reason: `reverted (${reverted})` };
  return { state: 'none' };
}

async function perplLanded(kind: EngineOrderKind, refId: string, userId: string): Promise<Landed> {
  const refs = getDb().prepare('SELECT account_id, rq FROM engine_orders WHERE ref_id = ? AND kind = ?').all(refId, kind) as { account_id: number; rq: number }[];
  if (refs.length === 0) return { state: 'none' };
  const rest = restFor(userId);
  const [history, open] = await Promise.all([rest.orderHistory(200), rest.openOrders()]);
  for (const r of refs) {
    const o = history.d.find((x) => x.acc === r.account_id && x.rq === r.rq);
    if (o && o.fs > 0) {
      const m = await getMarket(o.mkt);
      return { state: 'filled', sizeRaw: String(o.fs), notionalUsd: scale.unsize(o.fs, m) * scale.unprice(o.fp, m), txHash: o.at?.txid ?? null, orderId: o.oid };
    }
    if (o) return { state: 'failed', reason: `perpl order ${o.oid} ended with status ${o.st}, nothing filled` };
    if (open.d.some((x) => x.acc === r.account_id && x.rq === r.rq)) return { state: 'pending' };
  }
  return { state: 'none' };
}
