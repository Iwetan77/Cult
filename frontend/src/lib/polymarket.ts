// Prediction markets from Polymarket's public APIs (Gamma for markets and
// events, CLOB for price history). Both allow browser requests, so this works
// without our backend. An event is one question (a binary market) or a set of
// mutually exclusive outcomes (one binary market each, e.g. candidates).

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

export type PredictionOutcome = {
  id: string;            // Polymarket market id
  label: string;         // candidate / option name, or the question itself
  question: string;
  yesLabel: string;      // "Yes", or a team name on head-to-head markets
  noLabel: string;
  yesPrice: number;      // 0..1, also the implied probability
  noPrice: number;
  yesTokenId: string | null;
  noTokenId: string | null;
  change24h: number | null; // change in the Yes price over a day, 0..1
  volume24h: number;
  minSize: number;
};
export type PredictionEvent = {
  slug: string; title: string; description: string; image: string | null;
  endDate: string | null; volume24h: number; volume: number; liquidity: number;
  multi: boolean; outcomes: PredictionOutcome[];
};
export type PredictionCategory = { id: string; label: string; tagId: string | null };
export const CATEGORIES: PredictionCategory[] = [
  { id: 'trending', label: 'Trending', tagId: null },
  { id: 'politics', label: 'Politics', tagId: '2' },
  { id: 'crypto', label: 'Crypto', tagId: '21' },
  { id: 'sports', label: 'Sports', tagId: '1' },
  { id: 'economy', label: 'Economy', tagId: '100328' },
  { id: 'geopolitics', label: 'World', tagId: '100265' },
];

type RawEvent = { slug: string; title: string; description?: string; image?: string; icon?: string; endDate?: string; volume24hr?: number; volume?: number; liquidity?: number; negRisk?: boolean };
type RawMarket = {
  id: string; question: string; groupItemTitle?: string; outcomes?: string; outcomePrices?: string; clobTokenIds?: string;
  oneDayPriceChange?: number; volume24hr?: number; volumeNum?: number; orderMinSize?: number; image?: string; endDate?: string;
  description?: string; active?: boolean; closed?: boolean; negRisk?: boolean; events?: RawEvent[];
};

const parse = <T>(value: string | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };

function outcomeOf(m: RawMarket, multi: boolean): PredictionOutcome | null {
  const names = parse<string[]>(m.outcomes, ['Yes', 'No']);
  const prices = parse<string[]>(m.outcomePrices, []).map(Number);
  const tokens = parse<string[]>(m.clobTokenIds, []);
  if (prices.length < 2 || !prices.every(Number.isFinite)) return null;
  return {
    id: m.id, question: m.question,
    label: multi ? (m.groupItemTitle || m.question) : m.question,
    yesLabel: names[0] ?? 'Yes', noLabel: names[1] ?? 'No',
    yesPrice: prices[0]!, noPrice: prices[1]!,
    yesTokenId: tokens[0] ?? null, noTokenId: tokens[1] ?? null,
    change24h: typeof m.oneDayPriceChange === 'number' ? m.oneDayPriceChange : null,
    volume24h: m.volume24hr ?? 0, minSize: m.orderMinSize ?? 5,
  };
}

// Markets that belong to one event become one card. An event whose own
// question is a market (a game's winner, a yes/no) is that market; side
// markets (spreads, props) are left out. Otherwise each market is an option
// with a name ("Lula", "↑ $130k"), listed by chance.
function group(markets: RawMarket[], event: RawEvent): PredictionEvent | null {
  const live = markets.filter(m => m.active !== false && !m.closed);
  const main = live.find(m => m.question === event.title && !m.groupItemTitle);
  const multi = !main && (live.length > 1 || !!live[0]?.groupItemTitle);
  const outcomes = (main ? [main] : live).map(m => outcomeOf(m, multi)).filter((o): o is PredictionOutcome => !!o);
  if (!outcomes.length) return null;
  outcomes.sort(multi ? (a, b) => b.yesPrice - a.yesPrice : (a, b) => b.volume24h - a.volume24h);
  return {
    slug: event.slug, title: event.title, description: event.description ?? live[0]?.description ?? '',
    image: event.image || event.icon || live[0]?.image || null, endDate: event.endDate ?? live[0]?.endDate ?? null,
    volume24h: event.volume24hr ?? outcomes.reduce((sum, o) => sum + o.volume24h, 0), volume: event.volume ?? 0, liquidity: event.liquidity ?? 0,
    multi, outcomes: multi ? outcomes : outcomes.slice(0, 1),
  };
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Polymarket ${response.status}`);
  return response.json() as Promise<T>;
}

// Busiest live events (in a category), built from the market list, which is
// far lighter than the event list (that one embeds every side market).
const listCache = new Map<string, { at: number; events: PredictionEvent[] }>();
export async function listEvents(category: PredictionCategory): Promise<PredictionEvent[]> {
  const hit = listCache.get(category.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.events;
  try {
    const query = new URLSearchParams({ limit: '120', active: 'true', closed: 'false', order: 'volume24hr', ascending: 'false', ...(category.tagId ? { tag_id: category.tagId, related_tags: 'true' } : {}) });
    const markets = await get<RawMarket[]>(`${GAMMA}/markets?${query}`);
    const byEvent = new Map<string, { event: RawEvent; markets: RawMarket[] }>();
    for (const m of markets) {
      const event = m.events?.[0];
      if (!event?.slug) continue;
      const entry = byEvent.get(event.slug) ?? { event, markets: [] };
      entry.markets.push(m);
      byEvent.set(event.slug, entry);
    }
    const events = [...byEvent.values()].map(e => group(e.markets, e.event)).filter((e): e is PredictionEvent => !!e)
      .sort((a, b) => b.volume24h - a.volume24h);
    listCache.set(category.id, { at: Date.now(), events });
    return events;
  } catch {
    return hit?.events ?? FALLBACK.filter(e => category.id === 'trending' || e.category === category.id).map(withoutCategory);
  }
}

const eventCache = new Map<string, PredictionEvent>();
export const cachedEvent = (slug: string) => eventCache.get(slug) ?? null;
export async function getEvent(slug: string): Promise<PredictionEvent> {
  try {
    const [event] = await get<(RawEvent & { markets: RawMarket[] })[]>(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
    const grouped = event && group(event.markets, event);
    if (!grouped) throw new Error('This market is closed.');
    eventCache.set(slug, grouped);
    return grouped;
  } catch (reason) {
    const fallback = FALLBACK.find(e => e.slug === slug);
    if (fallback) return withoutCategory(fallback);
    throw reason;
  }
}

export type PricePoint = { time: number; value: number };
export type HistoryRange = '1d' | '1w' | '1m' | 'max';
const FIDELITY: Record<HistoryRange, number> = { '1d': 5, '1w': 60, '1m': 240, max: 1440 };
export async function getHistory(outcome: PredictionOutcome, range: HistoryRange): Promise<PricePoint[]> {
  if (outcome.yesTokenId && !outcome.yesTokenId.startsWith('demo-')) {
    try {
      const r = await get<{ history: { t: number; p: number }[] }>(`${CLOB}/prices-history?market=${outcome.yesTokenId}&interval=${range}&fidelity=${FIDELITY[range]}`);
      if (r.history.length > 1) return r.history.map(h => ({ time: h.t, value: h.p }));
    } catch { /* drawn below */ }
  }
  return syntheticHistory(outcome, range);
}

// A plausible path that ends at today's price, for offline/sample markets.
function syntheticHistory(o: PredictionOutcome, range: HistoryRange): PricePoint[] {
  const span = { '1d': 86_400, '1w': 604_800, '1m': 2_592_000, max: 7_776_000 }[range];
  const steps = 120, now = Math.floor(Date.now() / 1000);
  let seed = [...o.id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const points: number[] = [o.yesPrice];
  for (let i = 1; i < steps; i++) points.push(Math.min(0.99, Math.max(0.01, points[i - 1]! + (rand() - 0.5) * 0.04)));
  return points.reverse().map((value, i) => ({ time: now - span + Math.round((span / steps) * i), value }));
}

// Formatting: prices are cents, probabilities are percent.
export const cents = (p: number) => p >= 0.995 ? '99.9¢' : p < 0.01 ? '<1¢' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}¢`;
export const chance = (p: number) => p < 0.01 ? '<1%' : p > 0.99 ? '>99%' : `${Math.round(p * 100)}%`;
export const endsIn = (iso: string | null) => {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'Ending soon';
  const days = Math.floor(ms / 86_400_000);
  return days >= 1 ? `Ends in ${days}d` : `Ends in ${Math.max(1, Math.floor(ms / 3_600_000))}h`;
};

// A handful of sample markets for when Polymarket can't be reached.
type Fallback = PredictionEvent & { category: string };
const withoutCategory = (fallback: Fallback): PredictionEvent => { const event: Partial<Fallback> = { ...fallback }; delete event.category; return event as PredictionEvent; };
const o = (id: string, label: string, question: string, yes: number, extra: Partial<PredictionOutcome> = {}): PredictionOutcome => ({
  id, label, question, yesLabel: 'Yes', noLabel: 'No', yesPrice: yes, noPrice: Math.round((1 - yes) * 1000) / 1000,
  yesTokenId: `demo-${id}-y`, noTokenId: `demo-${id}-n`, change24h: null, volume24h: 0, minSize: 5, ...extra,
});
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const FALLBACK: Fallback[] = [
  { slug: 'demo-btc-150k', category: 'crypto', title: 'Will Bitcoin hit $150k by December 31?', description: 'Resolves Yes if Bitcoin trades at or above $150,000 on a major exchange before the end of the year.', image: '/logos/btc.svg', endDate: inDays(89), volume24h: 1_840_000, volume: 42_000_000, liquidity: 3_100_000, multi: false,
    outcomes: [o('d1', 'Will Bitcoin hit $150k by December 31?', 'Will Bitcoin hit $150k by December 31?', 0.23, { change24h: 0.02, volume24h: 1_840_000 })] },
  { slug: 'demo-fed-december', category: 'economy', title: 'Fed decision in December?', description: 'Which move will the Federal Reserve make at its December meeting?', image: null, endDate: inDays(75), volume24h: 960_000, volume: 18_500_000, liquidity: 2_400_000, multi: true,
    outcomes: [o('d2', '25 bps cut', 'Will the Fed cut 25 bps in December?', 0.58, { change24h: 0.03 }), o('d3', 'No change', 'Will the Fed hold rates in December?', 0.36, { change24h: -0.02 }), o('d4', '50+ bps cut', 'Will the Fed cut 50+ bps in December?', 0.05), o('d5', 'Increase', 'Will the Fed raise rates in December?', 0.01)] },
  { slug: 'demo-monad-tvl', category: 'crypto', title: 'Monad TVL above $5B by year end?', description: 'Resolves Yes if DefiLlama shows Monad TVL above $5 billion on December 31.', image: '/logos/mon.png', endDate: inDays(89), volume24h: 410_000, volume: 3_900_000, liquidity: 620_000, multi: false,
    outcomes: [o('d6', 'Monad TVL above $5B by year end?', 'Monad TVL above $5B by year end?', 0.41, { change24h: 0.06, volume24h: 410_000 })] },
  { slug: 'demo-champions-league', category: 'sports', title: 'Champions League winner', description: 'Which club will win this season’s UEFA Champions League?', image: null, endDate: inDays(240), volume24h: 720_000, volume: 64_000_000, liquidity: 5_200_000, multi: true,
    outcomes: [o('d7', 'Real Madrid', 'Will Real Madrid win the Champions League?', 0.19), o('d8', 'Arsenal', 'Will Arsenal win the Champions League?', 0.16), o('d9', 'Bayern Munich', 'Will Bayern Munich win the Champions League?', 0.13), o('d10', 'Barcelona', 'Will Barcelona win the Champions League?', 0.12), o('d11', 'PSG', 'Will PSG win the Champions League?', 0.1)] },
];
