import { OrderSide, OrderType, type OrderResponse, type SecureClient } from '@polymarket/client';
import { numEnv } from '../config/env.js';
import { cultRoom, postSystem } from '../api/chat.js';
import { avatarUrl, displayName } from '../api/names.js';
import { clans } from '../store/clans.js';
import { members } from '../store/members.js';
import { getJson } from '../http.js';
import { broker, forgetBalance, pusdBalance } from './account.js';
import { FlowError, type FlowStep } from './broker.js';
import { ownerClient, predictionsEnabled, sessionClient } from './client.js';
import { accessFor } from './geo.js';
import { marketByCondition, marketById, protectedPrice, type PmMarket } from './markets.js';
import { predictionAccounts, predictionPositions, type PredictionRow } from './store.js';

// Prediction bets on Polymarket for a member, in the shapes the app already
// uses (frontend/src/lib/contracts.ts: PredictionPosition, PredictionSale, ...).
// Bets are market orders (fill-and-kill) with price protection: never more
// than PREDICTIONS_SLIPPAGE (default 5%) past the price the member saw.
// With our session key the order is signed here; without one, the member's
// wallet signs it in the browser (the call answers needs_signature).

export interface PredictionOrder {
  marketId: string;
  eventSlug: string;
  eventTitle: string;
  outcomeLabel: string;
  question: string;
  image: string | null;
  side: 'yes' | 'no';
  sideLabel: string;
  price: number;
  amountUsd: number;
  cultIds?: string[];
}

export interface PredictionPosition {
  id: string;
  marketId: string;
  eventSlug: string;
  eventTitle: string;
  outcomeLabel: string;
  question: string;
  image: string | null;
  side: 'yes' | 'no';
  sideLabel: string;
  shares: number;
  avgPrice: number;
  costUsd: number;
  openedAt: number;
}

export interface PredictionSale {
  position: PredictionPosition;
  price: number;
  proceedsUsd: number;
  pnlUsd: number;
}

export interface PredictionBet {
  memberId: string;
  memberName: string;
  avatarUrl: string | null;
  cultName: string;
  marketId: string;
  outcomeLabel: string;
  side: 'yes' | 'no';
  sideLabel: string;
  shares: number;
  avgPrice: number;
}

const slippage = () => Math.min(0.2, Math.max(0.005, numEnv('PREDICTIONS_SLIPPAGE', 0.05)));

export const toApi = (p: PredictionRow): PredictionPosition => ({
  id: p.id,
  marketId: p.marketId,
  eventSlug: p.eventSlug,
  eventTitle: p.eventTitle,
  outcomeLabel: p.outcomeLabel,
  question: p.question,
  image: p.image,
  side: p.side,
  sideLabel: p.sideLabel,
  shares: p.shares,
  avgPrice: p.shares > 0 ? p.costUsd / p.shares : 0,
  costUsd: p.costUsd,
  openedAt: p.openedAt,
});

const cents = (p: number) => (p >= 0.995 ? '99.9¢' : p < 0.01 ? '<1¢' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}¢`);
const what = (p: { outcomeLabel: string; question: string; eventTitle: string }) =>
  p.outcomeLabel === p.question ? `"${p.question}"` : `${p.outcomeLabel} in "${p.eventTitle}"`;

function readyAccount(userId: string) {
  if (!predictionsEnabled()) throw new FlowError(409, 'Predictions are not available yet.');
  const acct = predictionAccounts.get(userId);
  if (!acct?.deployed || !acct.approvals) throw new FlowError(409, 'needs_setup: set up predictions first.');
  return acct;
}

// Run an order with our session key if the member has one, else have their
// wallet sign it in the browser.
async function withTrader<T>(userId: string, label: string, work: (client: SecureClient) => Promise<T>): Promise<FlowStep<T>> {
  const session = await sessionClient(userId).catch((e) => {
    console.warn(`[predictions] session client failed for ${userId.slice(-8)}: ${(e as Error).message}`);
    return null;
  });
  if (session) return { status: 'done', flowId: 'session', result: await work(session) };
  const m = members.get(userId)!;
  const acct = predictionAccounts.get(userId)!;
  return broker.start(userId, m.wallet, label, async (signer) => work(await ownerClient(userId, signer, acct.depositWallet)));
}

function filled(r: OrderResponse): { making: number; taking: number } {
  if (!r.ok) throw new FlowError(409, orderProblem(r.code, r.message));
  const making = Number(r.makingAmount);
  const taking = Number(r.takingAmount);
  if (!(making > 0 && taking > 0)) throw new FlowError(409, 'Nobody took the other side at that price. Try again.');
  return { making, taking };
}

function orderProblem(code: string, message: string): string {
  if (/balance|allowance/i.test(code + message)) return 'Not enough dollars in predictions for this bet.';
  if (/geo|region|restricted|forbidden/i.test(code + message)) return 'Polymarket does not take bets from your location.';
  if (/liquid|match|fok|fak|price/i.test(code + message)) return 'Nobody took the other side at that price. Try again.';
  return `Polymarket refused the order: ${message || code}`;
}

export async function buy(userId: string, order: PredictionOrder, country: string | null): Promise<FlowStep<PredictionPosition>> {
  const access = accessFor(country);
  if (access.predictions !== 'open') throw new FlowError(403, 'Polymarket does not take new bets from your location.');
  const acct = readyAccount(userId);
  const market = await marketById(order.marketId);
  if (!market) throw new FlowError(404, 'That market is not on Polymarket.');
  if (!market.tradable) throw new FlowError(409, 'This market is closed for betting.');
  if (!(order.price > 0 && order.price < 1)) throw new FlowError(400, 'This outcome can’t be bought right now.');
  if (!(order.amountUsd >= 1)) throw new FlowError(400, 'The smallest bet is $1.');
  if (order.amountUsd / order.price < market.minShares) throw new FlowError(400, `The smallest bet here is $${Math.ceil(market.minShares * order.price * 100) / 100}.`);
  const balance = await pusdBalance(acct.depositWallet).catch(() => null);
  if (balance != null && order.amountUsd > balance + 1e-6) throw new FlowError(409, `needs_funds: you have $${balance.toFixed(2)} in predictions.`);

  const tokenId = order.side === 'yes' ? market.yesToken : market.noToken;
  const sideLabel = order.side === 'yes' ? market.yesLabel : market.noLabel;
  const maxPrice = protectedPrice(order.price, 'buy', market.tick, slippage());
  const cultIds = Array.isArray(order.cultIds) ? order.cultIds.filter((id) => clans.membership(id, userId)) : null;

  return withTrader(userId, 'Confirm your bet', async (client) => {
    const r = await client.placeMarketOrder({ assetId: tokenId, side: OrderSide.BUY, amount: order.amountUsd, maxPrice, orderType: OrderType.FAK } as never);
    const { making, taking } = filled(r);
    forgetBalance(acct.depositWallet);
    const row = predictionPositions.addFill(userId, {
      marketId: market.id,
      conditionId: market.conditionId,
      tokenId,
      side: order.side,
      sideLabel,
      eventSlug: order.eventSlug,
      eventTitle: order.eventTitle,
      outcomeLabel: order.outcomeLabel || market.label,
      question: market.question,
      image: order.image ?? market.image,
      negRisk: market.negRisk,
      shares: taking,
      costUsd: making,
      cultIds,
    });
    for (const id of cultIds ?? clans.forUser(userId).map((c) => c.id)) postSystem(cultRoom(id), userId, `bet ${sideLabel.toUpperCase()} on ${what(row)} at ${cents(making / taking)}`);
    return toApi(row);
  });
}

export async function sell(userId: string, positionId: string, price: number, country: string | null): Promise<FlowStep<PredictionSale>> {
  if (accessFor(country).predictions === 'blocked') throw new FlowError(403, 'Polymarket does not allow trading from your location.');
  const acct = readyAccount(userId);
  const pos = predictionPositions.get(positionId);
  if (!pos || pos.userId !== userId || pos.closedAt) throw new FlowError(404, 'That position is already closed.');
  if (!(price > 0 && price < 1)) throw new FlowError(400, 'No price to sell at right now.');
  const market = (await marketById(pos.marketId)) ?? (await marketByCondition(pos.conditionId));
  const tick = market?.tick ?? 0.01;
  const live = await heldShares(acct.depositWallet, pos.tokenId);
  const shares = Math.floor(Math.min(pos.shares, live ?? pos.shares) * 100) / 100;
  if (!(shares > 0)) throw new FlowError(409, 'There are no shares left to sell. If the market resolved, collect it instead.');
  const minPrice = protectedPrice(price, 'sell', tick, slippage());

  return withTrader(userId, 'Confirm your sale', async (client) => {
    const r = await client.placeMarketOrder({ assetId: pos.tokenId, side: OrderSide.SELL, shares, minPrice, orderType: OrderType.FAK } as never);
    const { making: sold, taking: proceeds } = filled(r);
    forgetBalance(acct.depositWallet);
    const { costOfSold } = predictionPositions.sell(pos.id, sold, proceeds);
    const avg = proceeds / sold;
    for (const id of pos.cultIds ?? clans.forUser(userId).map((c) => c.id)) {
      if (clans.membership(id, userId)) postSystem(cultRoom(id), userId, `sold ${pos.sideLabel.toUpperCase()} on ${what(pos)} at ${cents(avg)}`);
    }
    return { position: toApi({ ...pos, shares: sold, costUsd: costOfSold }), price: avg, proceedsUsd: proceeds, pnlUsd: proceeds - costOfSold };
  });
}

// Collect a resolved market: winning shares pay $1 each into predictions.
export async function redeem(userId: string, positionId: string): Promise<FlowStep<{ positionId: string; payoutUsd: number; tx: string | null }>> {
  const acct = readyAccount(userId);
  const pos = predictionPositions.get(positionId);
  if (!pos || pos.userId !== userId || pos.closedAt) throw new FlowError(404, 'That position is already closed.');
  const held = await dataPositions(acct.depositWallet).then((list) => list.find((p) => p.asset === pos.tokenId));
  if (!held?.redeemable) throw new FlowError(409, 'This market has not resolved yet.');
  const payout = held.curPrice >= 0.5 ? 1 : 0;
  const m = members.get(userId)!;
  return broker.start(userId, m.wallet, 'Collect your winnings', async (signer) => {
    const client = await ownerClient(userId, signer, acct.depositWallet);
    const handle = await client.redeemPositions({ conditionId: pos.conditionId } as never);
    const outcome = await handle.wait();
    predictionPositions.resolve(pos.id, payout);
    forgetBalance(acct.depositWallet);
    return { positionId: pos.id, payoutUsd: pos.shares * payout, tx: outcome.transactionHash ?? null };
  });
}

// --- reading -------------------------------------------------------------------

interface DataPosition {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  icon?: string;
}

async function dataPositions(wallet: string): Promise<DataPosition[]> {
  return getJson<DataPosition[]>(`https://data-api.polymarket.com/positions?user=${wallet}&limit=500&sizeThreshold=0`, { timeoutMs: 6000, retries: 1 });
}

async function heldShares(wallet: string, tokenId: string): Promise<number | null> {
  const list = await dataPositions(wallet).catch(() => null);
  if (!list) return null;
  return list.find((p) => p.asset === tokenId)?.size ?? 0;
}

export async function positions(userId: string): Promise<{ positions: PredictionPosition[]; closed: Array<PredictionSale & { closedAt: number }>; redeemable: string[] }> {
  const acct = predictionAccounts.get(userId);
  const open = predictionPositions.open(userId);
  const redeemable: string[] = [];
  if (acct?.deployed && open.length) {
    const held = await dataPositions(acct.depositWallet).catch(() => null);
    if (held) {
      for (const p of open) {
        const h = held.find((x) => x.asset === p.tokenId);
        // Polymarket's count wins once it knows the position (fills settle
        // a little after placement); a fresh bet it hasn't indexed stays.
        if (h && Math.abs(h.size - p.shares) > 1e-6) {
          predictionPositions.setShares(p.id, h.size);
          p.shares = h.size;
        }
        if (h?.redeemable) redeemable.push(p.id);
      }
    }
  }
  const closed = predictionPositions.closed(userId).map((p) => {
    const proceeds = p.proceedsUsd ?? 0;
    return { position: toApi(p), price: p.closePrice ?? 0, proceedsUsd: proceeds, pnlUsd: proceeds - p.costUsd, closedAt: p.closedAt! };
  });
  return { positions: open.map(toApi), closed, redeemable };
}

// Cult-mates' open bets on one event: everyone who shares a cult with you,
// where they posted the bet to that cult (or to all their cults).
export function cultBets(userId: string, eventSlug: string): PredictionBet[] {
  const mine = clans.forUser(userId);
  const out: PredictionBet[] = [];
  const seen = new Set<string>();
  for (const p of predictionPositions.openOnEvent(eventSlug)) {
    if (p.userId === userId) continue;
    const shared = mine.find((c) => clans.membership(c.id, p.userId) && (!p.cultIds || p.cultIds.includes(c.id)));
    if (!shared || seen.has(p.id)) continue;
    seen.add(p.id);
    const m = members.get(p.userId);
    if (!m) continue;
    out.push({
      memberId: p.userId,
      memberName: displayName(m),
      avatarUrl: avatarUrl(m),
      cultName: shared.name,
      marketId: p.marketId,
      outcomeLabel: p.outcomeLabel,
      side: p.side,
      sideLabel: p.sideLabel,
      shares: p.shares,
      avgPrice: p.shares > 0 ? p.costUsd / p.shares : 0,
    });
  }
  return out.sort((a, b) => b.shares * b.avgPrice - a.shares * a.avgPrice);
}

export type { PmMarket };
