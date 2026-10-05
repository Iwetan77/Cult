import { getJson } from '../http.js';

// One Polymarket market (a binary question), from Gamma, as trading needs it:
// which token is Yes and which is No, the tick, the smallest order, whether
// it takes orders. Cached briefly; prices come from the order book at trade time.

const GAMMA = 'https://gamma-api.polymarket.com';

export interface PmMarket {
  id: string;
  conditionId: string;
  question: string;
  label: string; // "Lula", or the question on a plain yes/no
  yesLabel: string;
  noLabel: string;
  yesToken: string;
  noToken: string;
  yesPrice: number | null;
  negRisk: boolean;
  tick: number;
  minShares: number;
  tradable: boolean;
  image: string | null;
}

interface RawMarket {
  id: string;
  question: string;
  conditionId: string;
  groupItemTitle?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  negRisk?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  image?: string;
}

const parse = <T>(v: string | undefined, fallback: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function toPmMarket(m: RawMarket): PmMarket | null {
  const tokens = parse<string[]>(m.clobTokenIds, []);
  const names = parse<string[]>(m.outcomes, ['Yes', 'No']);
  const prices = parse<string[]>(m.outcomePrices, []).map(Number);
  if (tokens.length < 2 || !m.conditionId) return null;
  return {
    id: String(m.id),
    conditionId: m.conditionId,
    question: m.question,
    label: m.groupItemTitle || m.question,
    yesLabel: names[0] ?? 'Yes',
    noLabel: names[1] ?? 'No',
    yesToken: tokens[0]!,
    noToken: tokens[1]!,
    yesPrice: Number.isFinite(prices[0]) ? prices[0]! : null,
    negRisk: !!m.negRisk,
    tick: m.orderPriceMinTickSize && m.orderPriceMinTickSize > 0 ? m.orderPriceMinTickSize : 0.01,
    minShares: m.orderMinSize && m.orderMinSize > 0 ? m.orderMinSize : 5,
    tradable: m.active !== false && !m.closed && m.acceptingOrders !== false && m.enableOrderBook !== false,
    image: m.image || null,
  };
}

const cache = new Map<string, { at: number; market: PmMarket }>();

export async function marketById(id: string): Promise<PmMarket | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.market;
  if (!/^\d+$/.test(id)) return null;
  const raw = await getJson<RawMarket>(`${GAMMA}/markets/${id}`).catch(() => null);
  const market = raw ? toPmMarket(raw) : null;
  if (market) cache.set(id, { at: Date.now(), market });
  return market;
}

export async function marketByCondition(conditionId: string): Promise<PmMarket | null> {
  const list = await getJson<RawMarket[]>(`${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}`).catch(() => []);
  const market = list[0] ? toPmMarket(list[0]) : null;
  if (market) cache.set(market.id, { at: Date.now(), market });
  return market;
}

// Price protection: the worst price we accept, a few % past the one the member
// saw, on the market's tick grid and inside (0, 1).
export function protectedPrice(seen: number, side: 'buy' | 'sell', tick: number, slippage: number): number {
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  const round = (x: number) => Number(x.toFixed(decimals));
  if (side === 'buy') {
    const p = Math.ceil((seen * (1 + slippage)) / tick) * tick;
    return round(Math.min(1 - tick, Math.max(tick, p)));
  }
  const p = Math.floor((seen * (1 - slippage)) / tick) * tick;
  return round(Math.min(1 - tick, Math.max(tick, p)));
}
