import type { BackendConfig, Candle, ChartMarker, ChartSnapshot, ChatMessage, ChatPage, BoardPeriod, ChatRoom, Clan, ClosedTrade, CultStanding, DepositInfo, DiscoverCult, Fill, Holding, Home, Leaderboard, LeaderboardEntry, Market, MarketDetail, MarketListing, Me, Member, MirrorPolicy, Profile, TpslSuggestion, TradeView, Venue, WithdrawRequest, WithdrawResult, PredictionBet, PredictionClosed, PredictionOrder, PredictionPosition, PredictionSale } from './contracts';
import { cents } from './polymarket';
import { cachedList } from './marketCache';

// Demo mode: the whole app, signed out, on realistic sample data. Every API
// call is answered here instead of the backend. Public market data is still
// fetched from the real API when it's reachable, so prices and charts can be
// live; everything about you, your cults and their trades is sample data that
// your clicks change (kept for the browser session).
// Turn it on with NEXT_PUBLIC_ENABLE_DEMO=1, then ?demo=1 or "Explore the demo".

const KEY = 'cult:demo';
const STORE = 'cult:demo:state:v1';
let forced = false;

export const demoEnabled = () => process.env.NEXT_PUBLIC_ENABLE_DEMO === '1';
export function isDemo(): boolean {
  if (typeof window === 'undefined' || !demoEnabled()) return false;
  if (forced) return true;
  try {
    const flag = new URLSearchParams(window.location.search).get('demo');
    if (flag === '1') window.sessionStorage.setItem(KEY, '1');
    if (flag === '0') { window.sessionStorage.removeItem(KEY); window.sessionStorage.removeItem(STORE); }
    return window.sessionStorage.getItem(KEY) === '1';
  } catch { return new URLSearchParams(window.location.search).get('demo') === '1'; }
}
export function enterDemo() { forced = true; try { window.sessionStorage.setItem(KEY, '1'); } catch { /* in-memory flag covers it */ } }
export function exitDemo() {
  forced = false;
  state = null;
  try { window.sessionStorage.removeItem(KEY); window.sessionStorage.removeItem(STORE); } catch { /* nothing kept */ }
}

export const DEMO_ADDRESS = '0x7a3E91c2B04f5D86a1e3C9b27F0d84E5a6c1B2d9' as const;

// ---------- deterministic randomness ----------
const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const addr = (seed: string) => { const r = rng(hash(seed)); return `0x${Array.from({ length: 40 }, () => Math.floor(r() * 16).toString(16)).join('')}`; };

// ---------- markets ----------
type Fixture = { symbol: string; name: string; venue: Venue; price: number; change: number; volume: number; lev: number; vol: number };
const FIXTURES: Fixture[] = [
  { symbol: 'BTC-PERP', name: 'Bitcoin', venue: 'perpl', price: 67420, change: 2.31, volume: 412_800_000, lev: 50, vol: 0.006 },
  { symbol: 'ETH-PERP', name: 'Ethereum', venue: 'perpl', price: 3215.4, change: -0.84, volume: 188_200_000, lev: 50, vol: 0.008 },
  { symbol: 'SOL-PERP', name: 'Solana', venue: 'perpl', price: 158.21, change: 4.12, volume: 96_400_000, lev: 20, vol: 0.011 },
  { symbol: 'MON-PERP', name: 'Monad', venue: 'perpl', price: 0.4213, change: 7.85, volume: 54_100_000, lev: 10, vol: 0.016 },
  { symbol: 'HYPE-PERP', name: 'Hyperliquid', venue: 'perpl', price: 38.62, change: -3.27, volume: 41_700_000, lev: 20, vol: 0.014 },
  { symbol: 'ZEC-PERP', name: 'Zcash', venue: 'perpl', price: 61.2, change: 1.08, volume: 12_900_000, lev: 10, vol: 0.013 },
  { symbol: 'LIT-PERP', name: 'Lighter', venue: 'perpl', price: 1.842, change: -5.61, volume: 8_300_000, lev: 10, vol: 0.02 },
  { symbol: 'PUMP-PERP', name: 'Pump', venue: 'perpl', price: 0.006114, change: 11.4, volume: 6_100_000, lev: 5, vol: 0.024 },
  { symbol: 'VVV-PERP', name: 'Venice', venue: 'perpl', price: 4.27, change: 0.62, volume: 3_400_000, lev: 5, vol: 0.018 },
  { symbol: '$MOE', name: 'Moe', venue: 'nadfun', price: 0.000421, change: 38.2, volume: 912_000, lev: 1, vol: 0.04 },
  { symbol: '$CHOG', name: 'Chog', venue: 'nadfun', price: 0.001318, change: 12.7, volume: 640_000, lev: 1, vol: 0.035 },
  { symbol: '$MOLANDAK', name: 'Molandak', venue: 'nadfun', price: 0.000874, change: -9.4, volume: 402_000, lev: 1, vol: 0.038 },
  { symbol: '$NADDY', name: 'Naddy', venue: 'nadfun', price: 0.0000512, change: 64.9, volume: 288_000, lev: 1, vol: 0.05 },
  { symbol: '$BLOB', name: 'Blob', venue: 'nadfun', price: 0.002107, change: -2.2, volume: 151_000, lev: 1, vol: 0.03 },
];
const fixtureId = (f: Fixture) => f.venue === 'perpl' ? f.symbol : f.symbol.slice(1).toLowerCase();
const fixtureBy = (idOrSymbol: string) => FIXTURES.find(f => fixtureId(f).toLowerCase() === idOrSymbol.toLowerCase() || f.symbol.toLowerCase() === idOrSymbol.toLowerCase());
// A slow wobble so prices move between refreshes.
const live = (f: Fixture) => f.price * (1 + 0.0035 * Math.sin(Date.now() / 47_000 + (hash(f.symbol) % 100)) + 0.0012 * Math.sin(Date.now() / 9_000 + (hash(f.name) % 50)));
const fixtureListing = (f: Fixture): MarketListing => ({ venue: f.venue, id: fixtureId(f), symbol: f.symbol, name: f.name, priceUsd: live(f), change24hPct: f.change, volume24hUsd: f.volume, imageUri: null, maxLeverage: f.lev });

function makeCandles(f: Fixture, resolution: number, count = 180): Candle[] {
  const r = rng(hash(f.symbol + resolution));
  const step = f.vol * Math.sqrt(resolution / 3600);
  const bias = (f.change / 100) / Math.max(1, 86_400 / resolution) * 0.6;
  const end = Math.floor(Date.now() / 1000 / resolution) * resolution;
  const out: Candle[] = [];
  let close = live(f);
  for (let i = 0; i < count; i++) {
    const move = (r() - 0.5) * 2 * step + bias;
    const open = close / (1 + move);
    const high = Math.max(open, close) * (1 + r() * step * 0.7);
    const low = Math.min(open, close) * (1 - r() * step * 0.7);
    out.push({ time: end - i * resolution, open, high, low, close });
    close = open;
  }
  return out.reverse();
}

// Market data from the real API when it answers, else the fixtures.
let realDown = false;
let realOk = false;
let probe: Promise<boolean> | null = null;
async function tryReal<T>(real: () => Promise<T>): Promise<T | null> {
  if (realDown || !process.env.NEXT_PUBLIC_CULT_API_BASE_URL) return null;
  // The first call finds out whether the API answers us (CORS); the rest wait for it.
  if (!probe) {
    let first: T | null = null;
    probe = real().then(value => { first = value; realOk = true; return true; }, () => { realDown = true; return false; });
    return await probe ? first : null;
  }
  if (!await probe) return null;
  try { return await real(); } catch { return null; }
}
// The cached list only counts as real market data once the API has answered.
const realList = () => realOk ? cachedList('') ?? [] : [];
const allListings = (): MarketListing[] => {
  const list = realList();
  return list.length ? list : FIXTURES.map(fixtureListing);
};
function resolveListing(idOrSymbol: string): MarketListing | null {
  const key = idOrSymbol.toLowerCase();
  const fromReal = realList().find(m => m.id.toLowerCase() === key || m.symbol.toLowerCase() === key);
  if (fromReal) return fromReal;
  const f = fixtureBy(idOrSymbol);
  return f ? fixtureListing(f) : null;
}
const priceOf = (symbol: string) => {
  const f = fixtureBy(symbol);
  const realHit = realList().find(m => m.symbol.toLowerCase() === symbol.toLowerCase());
  return realHit?.priceUsd ?? (f ? live(f) : 1);
};
const toMarket = (l: MarketListing): Market => ({ venue: l.venue, id: l.id, symbol: l.symbol, baseSymbol: l.symbol.replace(/-PERP$/, '').replace(/^\$/, ''), quoteSymbol: 'USD', maxLeverage: l.maxLeverage, makerFeeBps: 2, takerFeeBps: 5 });

// ---------- people ----------
type Person = { id: string; name: string; avatar: string | null; country: string };
const PEOPLE: Person[] = [
  { id: 'm-krdnl', name: 'krdnl', avatar: '/landing/avatar-krdnl.png', country: 'NG' },
  { id: 'm-tandid', name: '0xtandid', avatar: '/landing/avatar-0xtandid.png', country: 'GB' },
  { id: 'm-daddy', name: '23daddy', avatar: '/landing/avatar-23daddy.png', country: 'NG' },
  { id: 'm-solstice', name: 'solstice', avatar: '/landing/avatar-solstice.png', country: 'US' },
  { id: 'm-conscott', name: 'conscott88', avatar: null, country: 'US' },
  { id: 'm-ada', name: 'ada_longs', avatar: null, country: 'NG' },
  { id: 'm-mira', name: 'mira.eth', avatar: null, country: 'DE' },
  { id: 'm-tunde', name: 'tunde_fx', avatar: null, country: 'NG' },
  { id: 'm-owl', name: 'nightowl', avatar: null, country: 'CA' },
  { id: 'm-kemi', name: 'kemi.trades', avatar: null, country: 'NG' },
  { id: 'm-zed', name: 'zed_perps', avatar: null, country: 'KE' },
  { id: 'm-lola', name: 'lola_onchain', avatar: null, country: 'GH' },
];
const ME_ID = 'm-me';
const person = (id: string): Person => id === ME_ID ? { id: ME_ID, name: state?.me.name ?? 'cultdemo', avatar: state?.me.avatarUrl ?? null, country: 'NG' } : PEOPLE.find(p => p.id === id) ?? { id, name: id.replace(/^m-/, ''), avatar: null, country: 'US' };

function statsFor(id: string): Member['stats'] {
  const r = rng(hash(id + 'stats'));
  const tradeCount = 14 + Math.floor(r() * 120);
  const winRate = 0.42 + r() * 0.36;
  const pnl = Math.round((r() * 14_000 - 2_500) * 100) / 100;
  return {
    verified: true, tradeCount, winRate, realizedPnlPerplUsd: pnl * 0.8, realizedPnlMon: Math.round(r() * 9000), realizedPnlUsd: pnl,
    monPriceUsed: 0.42, lastTradeAt: Date.now() - Math.floor(r() * 86_400_000), streak: Math.floor(r() * 7), avgWinPct: 6 + r() * 30,
    copied: { tradeCount: Math.floor(r() * 40), winRate: 0.4 + r() * 0.35, realizedPnlUsd: Math.round(r() * 2400 - 300) },
  };
}
const memberOf = (id: string): Member => {
  const p = person(id);
  const stats = id === ME_ID ? myStats() : statsFor(id);
  return { id, name: p.name, avatarUrl: p.avatar, address: id === ME_ID ? DEMO_ADDRESS : addr(id), winRate: stats.winRate, realizedPnlUsd: stats.realizedPnlUsd, tradeCount: stats.tradeCount, verified: true, stats };
};
const myStats = (): Member['stats'] => {
  const closed = state?.myClosed ?? [];
  const pnl = closed.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
  const perpPnl = closed.filter(t => t.venue === 'perpl').reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
  const wins = closed.filter(t => t.isWin).length;
  const trades = 37 + closed.length;
  return {
    verified: true, tradeCount: trades, winRate: (0.622 * 37 + wins) / trades, realizedPnlPerplUsd: 1630.2 + perpPnl, realizedPnlMon: 2210, realizedPnlUsd: 2558.4 + pnl,
    monPriceUsed: 0.42, lastTradeAt: closed[0]?.closedAt ?? Date.now() - 3_600_000, streak: 3, avgWinPct: 14.6,
    copied: { tradeCount: 12, winRate: 0.58, realizedPnlUsd: 412.8 },
  };
};

// ---------- state ----------
type Seed = {
  id: string; cultId: string; memberId: string; symbol: string; origin: ChartMarker['origin']; side: ChartMarker['side'];
  entryRatio: number; notional: number; leverage: number; openedAgoMin: number;
  tp: number | null; sl: number | null; suggestions: TpslSuggestion[]; skipUntil?: string;
};
type Position = { symbol: string; side: Holding['side']; entryRatio: number; margin: number; leverage: number; openedAt: number; autoSeed?: string; fromMargin?: number };
type State = {
  me: Me; base: Record<string, number>; seeds: Seed[]; positions: Position[];
  messages: Record<string, ChatMessage[]>; pinned: Record<string, ChatPage['pinned']>;
  members: Record<string, string[]>; discover: DiscoverCult[]; challenges: Record<string, MirrorPolicy>; next: number;
  predictions?: PredictionPosition[]; predictionHistory?: PredictionClosed[];
  // Cross-chain moves started in this demo (by deposit address).
  swaps?: Record<string, { kind: 'deposit' | 'withdraw'; usd: number; at: number; sent: boolean; credited: boolean; symbol: string; receive: string; receiveSymbol: string; chainName: string }>;
  myClosed?: ClosedTrade[]; // trades you closed in this demo, newest first
  lastActivity?: number; // when a cult-mate last opened a trade on their own
  lastChat?: number; // when a cult-mate last said something
};
let state: State | null = null;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const policy = (enabled: boolean, cap = 10, usd = 50): MirrorPolicy => ({ enabled, balancePercentCap: cap, maxUsdPerTrade: usd });

function seedState(): State {
  const clans: Clan[] = [
    { id: 'night-shift', name: 'Night Shift', inviteCode: 'NGT-SHF', visibility: 'private', isOwner: true, memberCount: 7, myPolicy: policy(true, 10, 50), autoFollow: true },
    { id: 'lagos-degens', name: 'Lagos Degens', inviteCode: 'LAG-DGN', visibility: 'public', isOwner: false, memberCount: 24, myPolicy: policy(false), autoFollow: false },
  ];
  const members: Record<string, string[]> = {
    'night-shift': [ME_ID, 'm-krdnl', 'm-tandid', 'm-daddy', 'm-solstice', 'm-conscott', 'm-ada'],
    'lagos-degens': [ME_ID, 'm-tunde', 'm-kemi', 'm-mira', 'm-owl', 'm-zed', 'm-lola'],
  };
  let n = 0;
  const seed = (cultId: string, memberId: string, symbol: string, origin: Seed['origin'], side: Seed['side'], entryRatio: number, notional: number, leverage: number, openedAgoMin: number, extra: Partial<Seed> = {}): Seed =>
    ({ id: `mk-${++n}`, cultId, memberId, symbol, origin, side, entryRatio, notional, leverage, openedAgoMin, tp: null, sl: null, suggestions: [], ...extra });
  const seeds: Seed[] = [
    seed('night-shift', 'm-krdnl', 'BTC-PERP', 'leader', 'long', 0.982, 12_500, 5, 340, { tp: 1.04, sl: 0.965 }),
    seed('night-shift', ME_ID, 'BTC-PERP', 'auto_mirror', 'long', 0.982, 1_250, 5, 339),
    seed('night-shift', 'm-tandid', 'BTC-PERP', 'leader', 'short', 1.008, 2_700, 3, 95, { tp: 0.975, sl: 1.025 }),
    seed('night-shift', 'm-ada', 'BTC-PERP', 'manual_stack', 'long', 0.991, 800, 2, 160),
    seed('night-shift', 'm-daddy', 'ETH-PERP', 'leader', 'long', 0.975, 18_000, 10, 610, { tp: 1.06 }),
    seed('night-shift', 'm-solstice', 'ETH-PERP', 'leader', 'short', 1.012, 2_400, 4, 75),
    seed('night-shift', ME_ID, 'SOL-PERP', 'leader', 'short', 1.021, 900, 3, 220, { sl: 1.05, suggestions: [{ id: 'sg-1', markerId: 'mk-7', tradeId: 'tr-mk-7', fromMemberId: 'm-tandid', fromName: '0xtandid', takeProfitPrice: null, stopLossPrice: null, createdAt: minutesAgo(40) }] }),
    seed('night-shift', 'm-conscott', 'SOL-PERP', 'auto_mirror', 'short', 1.021, 450, 3, 219),
    seed('night-shift', 'm-solstice', 'HYPE-PERP', 'leader', 'long', 0.94, 6_000, 5, 1_300, { tp: 1.12, sl: 0.9 }),
    seed('night-shift', 'm-krdnl', '$CHOG', 'leader', 'buy', 0.82, 150, 1, 900),
    seed('lagos-degens', 'm-tunde', 'BTC-PERP', 'leader', 'long', 0.995, 9_000, 10, 50),
    seed('lagos-degens', 'm-kemi', 'BTC-PERP', 'leader', 'short', 1.004, 2_500, 5, 130),
    seed('lagos-degens', ME_ID, '$MOE', 'leader', 'buy', 0.88, 40, 1, 520),
    seed('lagos-degens', 'm-mira', '$MOE', 'leader', 'buy', 0.7, 300, 1, 1_900),
    seed('lagos-degens', 'm-zed', 'SOL-PERP', 'leader', 'long', 0.968, 1_500, 3, 700),
    seed('lagos-degens', 'm-owl', 'MON-PERP', 'leader', 'long', 0.9, 3_000, 5, 1_100),
  ];
  // Suggestion prices are relative too: filled in when shown.
  const positions: Position[] = [
    { symbol: 'BTC-PERP', side: 'long', entryRatio: 0.982, margin: 250, leverage: 5, openedAt: Date.now() - 339 * 60_000 },
    { symbol: 'SOL-PERP', side: 'short', entryRatio: 1.021, margin: 300, leverage: 3, openedAt: Date.now() - 220 * 60_000 },
    { symbol: '$MOE', side: 'buy', entryRatio: 0.88, margin: 40, leverage: 1, openedAt: Date.now() - 520 * 60_000 },
  ];

  const msg = (room: string, memberId: string, body: string, ago: number, kind: ChatMessage['kind'] = 'text', markerId: string | null = null, replyTo: string | null = null): ChatMessage => {
    const p = person(memberId);
    const clanId = room.startsWith('cult:') ? room.slice(5) : null;
    return { id: `msg-${room}-${ago}-${hash(body) % 9999}`, room, kind, clanId, memberId, memberName: memberId === ME_ID ? 'cultdemo' : p.name, memberAvatarUrl: p.avatar, body, text: kind === 'system' ? `${p.name} ${body}` : body, replyTo, markerId, createdAt: minutesAgo(ago) };
  };
  const messages: Record<string, ChatMessage[]> = {
    global: [
      msg('global', 'm-zed', 'gm cult. who is still holding SOL longs from yesterday?', 190),
      msg('global', 'm-lola', 'still in. 3x, stop under 150', 186),
      msg('global', 'm-conscott', 'BTC looking heavy into the weekly close ngl', 120),
      msg('global', 'm-mira', 'heavy where? funding is flat, OI climbing. squeeze setup', 116),
      msg('global', 'm-owl', 'MON perps volume is wild today', 64),
      msg('global', 'm-tunde', 'Lagos Degens is up 18% this week, come through', 41),
      msg('global', 'm-kemi', 'anyone copying solstice on HYPE? that entry was clean', 22),
      msg('global', 'm-solstice', 'took half off at +9%, rest rides with a stop at entry', 18),
      msg('global', 'm-daddy', 'welcome to everyone who joined from the landing page 🫡', 6),
    ],
    'country:NG': [
      msg('country:NG', 'm-tunde', 'Naija traders, what are we watching this week?', 300),
      msg('country:NG', 'm-kemi', 'BTC 70k or bust', 290),
      msg('country:NG', 'm-ada', 'ETH/BTC ratio about to turn, mark it', 140),
      msg('country:NG', 'm-krdnl', 'just opened a BTC long in Night Shift, chart is on the cult page', 90),
      msg('country:NG', 'm-daddy', 'deposits with USDC landed in under a minute for me', 30),
    ],
    'cult:night-shift': [
      msg('cult:night-shift', 'm-daddy', 'joined the group', 4_000, 'system'),
      msg('cult:night-shift', 'm-krdnl', 'Plan for the week: buy the dips on BTC, keep size small on alts.', 380),
      msg('cult:night-shift', 'm-tandid', 'agree on BTC. I will fade the pop if we tag 68k', 372),
      msg('cult:night-shift', 'm-krdnl', 'opened BTC-PERP long 5x', 340, 'system', 'mk-1'),
      msg('cult:night-shift', ME_ID, 'copied it. auto-follow sized me at $250', 338),
      msg('cult:night-shift', 'm-ada', 'stacked 2x on top, stop under the range low', 160),
      msg('cult:night-shift', 'm-daddy', 'opened ETH-PERP long 10x', 610, 'system', 'mk-5'),
      msg('cult:night-shift', ME_ID, 'opened SOL-PERP short 3x', 220, 'system', 'mk-7'),
      msg('cult:night-shift', 'm-tandid', 'opened BTC-PERP short 3x', 95, 'system', 'mk-3'),
      msg('cult:night-shift', 'm-tandid', 'hedging, not fighting you krdnl 😅 TP at 65.7k', 93),
      msg('cult:night-shift', 'm-solstice', 'opened ETH-PERP short 4x', 75, 'system', 'mk-6'),
      msg('cult:night-shift', 'm-krdnl', 'all good. BTC long is +1.8% so far, moving my stop to entry', 30),
      msg('cult:night-shift', 'm-conscott', 'nice. how much are you all allocating per trade?', 12),
    ],
    'cult:lagos-degens': [
      msg('cult:lagos-degens', 'm-tunde', 'welcome to Lagos Degens. public cult, 10x max, no crying', 5_000),
      msg('cult:lagos-degens', 'm-mira', 'bought $MOE', 1_900, 'system', 'mk-14'),
      msg('cult:lagos-degens', ME_ID, 'bought $MOE', 520, 'system', 'mk-13'),
      msg('cult:lagos-degens', 'm-zed', 'opened SOL-PERP long 3x', 700, 'system', 'mk-15'),
      msg('cult:lagos-degens', 'm-tunde', 'opened BTC-PERP long 10x', 50, 'system', 'mk-11'),
      msg('cult:lagos-degens', 'm-kemi', 'tunde 10x at the highs is crazy work', 46),
      msg('cult:lagos-degens', 'm-tunde', 'conviction 😤', 44),
    ],
  };
  const rooms: ChatRoom[] = [
    { id: 'global', kind: 'global', name: 'Global', icon: 'G', memberCount: 1284, lastMessage: null },
    { id: 'country:NG', kind: 'country', name: 'Nigeria', icon: '🇳🇬', memberCount: 312, lastMessage: null },
    { id: 'cult:night-shift', kind: 'cult', name: 'Night Shift', icon: 'N', memberCount: 7, lastMessage: null },
    { id: 'cult:lagos-degens', kind: 'cult', name: 'Lagos Degens', icon: 'L', memberCount: 24, lastMessage: null },
  ];
  const me: Me = {
    id: ME_ID, address: DEMO_ADDRESS, name: 'cultdemo', username: 'cultdemo', needsUsername: false, avatarUrl: null,
    country: { code: 'NG', name: 'Nigeria' }, rooms, clans,
    perpl: { accountId: '4821', keyEnrolled: true, forwarding: true },
    balances: { perplMarginUsd: 382.1, walletUsd: 1240.55, mon: 5210, monUsd: 5210 * 0.42, gasReserveMon: 0.25, lowGas: false, memesPayWith: 'ausd' },
    signer: { prepared: true, attached: true, policyCurrent: true },
    usdcConverted: null,
  };
  const discover: DiscoverCult[] = [
    { id: 'lagos-degens', name: 'Lagos Degens', visibility: 'public', memberCount: 24, createdAt: minutesAgo(60 * 24 * 40), joined: true },
    { id: 'alpha-syndicate', name: 'Alpha Syndicate', visibility: 'public', memberCount: 112, createdAt: minutesAgo(60 * 24 * 90), joined: false },
    { id: 'perp-monks', name: 'Perp Monks', visibility: 'public', memberCount: 58, createdAt: minutesAgo(60 * 24 * 30), joined: false },
    { id: 'degen-choir', name: 'Degen Choir', visibility: 'public', memberCount: 76, createdAt: minutesAgo(60 * 24 * 12), joined: false },
    { id: 'monad-maxis', name: 'Monad Maxis', visibility: 'public', memberCount: 41, createdAt: minutesAgo(60 * 24 * 8), joined: false },
    { id: 'low-lev-club', name: 'Low Lev Club', visibility: 'public', memberCount: 19, createdAt: minutesAgo(60 * 24 * 3), joined: false },
  ];
  return { me, base: {}, seeds, positions, messages, pinned: { 'cult:night-shift': null }, members, discover, challenges: {}, next: 100 };
}

function load(): State {
  if (state) return state;
  try {
    const saved = window.sessionStorage.getItem(STORE);
    if (saved) { state = JSON.parse(saved) as State; return state; }
  } catch { /* fresh state */ }
  state = seedState();
  return state;
}
const save = () => { try { if (state) window.sessionStorage.setItem(STORE, JSON.stringify(state)); } catch { /* session only */ } };

// Entry prices are kept relative to the first price we saw for a market, so
// sample positions sit sensibly on real or sample charts alike.
const baseOf = (s: State, symbol: string) => (s.base[symbol] ??= priceOf(symbol));

function materialize(s: State, seed: Seed): ChartMarker {
  const listing = resolveListing(seed.symbol);
  const mark = priceOf(seed.symbol);
  const entry = baseOf(s, seed.symbol) * seed.entryRatio;
  const perp = seed.side !== 'buy';
  const direction = seed.side === 'short' ? -1 : 1;
  const p = person(seed.memberId);
  return {
    id: seed.id, tradeId: `tr-${seed.id}`, memberId: seed.memberId, memberName: seed.memberId === ME_ID ? s.me.name : p.name,
    marketId: listing?.id ?? seed.symbol, venue: perp ? 'perpl' : 'nadfun', origin: seed.origin, side: seed.side,
    entryTime: Math.floor((Date.now() - seed.openedAgoMin * 60_000) / 1000), entryPrice: entry, markPrice: mark, size: seed.notional / entry,
    pnlUsd: perp ? direction * (mark - entry) / entry * seed.notional : null, valueUsd: perp ? null : seed.notional * mark / entry,
    leverage: perp ? seed.leverage : null,
    takeProfitPrice: seed.tp == null ? null : seed.tp > 10 ? seed.tp : entry * seed.tp,
    stopLossPrice: seed.sl == null ? null : seed.sl > 10 ? seed.sl : entry * seed.sl,
    suggestions: seed.suggestions.map(x => ({ ...x, takeProfitPrice: x.takeProfitPrice ?? (seed.side === 'short' ? entry * 0.96 : entry * 1.05), stopLossPrice: x.stopLossPrice ?? (seed.side === 'short' ? entry * 1.04 : entry * 0.97) })),
    isMine: seed.memberId === ME_ID, mirrorStatus: seed.origin === 'auto_mirror' ? (seed.skipUntil && Date.parse(seed.skipUntil) > Date.now() ? 'pending' : 'filled') : undefined,
    skipUntil: seed.skipUntil, pendingAdd: null,
  };
}

// Every few minutes a cult-mate opens a trade, as they would live: it posts in
// the cult and lands on its chart (and so reaches your alerts).
const ACTIVITY_EVERY_MS = 150_000;
// Cult-mates also talk: about once a minute someone says something.
const CHAT_EVERY_MS = 60_000;
const CHAT_LINES = [
  'anyone else watching this BTC range?', 'took profit, back in on the dip', 'MON looking strong today',
  'who is still holding SOL?', 'tight stops tonight, chop everywhere', 'that HYPE move was clean',
  'adding a little here', 'gm cult', 'funding is wild on ETH rn', 'patience. waiting for the retest',
];
function cultChat(s: State) {
  const now = Date.now();
  if (s.lastChat == null) { s.lastChat = now; return; }
  if (now - s.lastChat < CHAT_EVERY_MS) return;
  s.lastChat = now;
  const cults = s.me.clans.filter(c => (s.members[c.id] ?? []).some(id => id !== ME_ID));
  const clan = cults[Math.floor(Math.random() * cults.length)];
  if (!clan) return;
  const mates = (s.members[clan.id] ?? []).filter(id => id !== ME_ID);
  post(s, `cult:${clan.id}`, mates[Math.floor(Math.random() * mates.length)]!, CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)]!, 'text');
}

function cultActivity(s: State) {
  cultChat(s);
  const now = Date.now();
  if (s.lastActivity == null) { s.lastActivity = now; return; }
  if (now - s.lastActivity < ACTIVITY_EVERY_MS) return;
  s.lastActivity = now;
  const cults = s.me.clans.filter(c => (s.members[c.id] ?? []).some(id => id !== ME_ID));
  const clan = cults[Math.floor(Math.random() * cults.length)];
  if (!clan) return;
  const mates = (s.members[clan.id] ?? []).filter(id => id !== ME_ID);
  const memberId = mates[Math.floor(Math.random() * mates.length)]!;
  const symbol = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'MON-PERP'][Math.floor(Math.random() * 5)]!;
  if (!resolveListing(symbol)) return;
  const side = Math.random() > 0.4 ? 'long' : 'short';
  const leverage = [3, 5, 10][Math.floor(Math.random() * 3)]!;
  const id = `mk-${++s.next}`;
  s.seeds = s.seeds.filter(x => !(x.memberId === memberId && x.cultId === clan.id && x.symbol === symbol));
  s.seeds.push({ id, cultId: clan.id, memberId, symbol, origin: 'leader', side, entryRatio: priceOf(symbol) / baseOf(s, symbol), notional: 100 + Math.round(Math.random() * 900), leverage, openedAgoMin: 0, tp: null, sl: null, suggestions: [] });
  post(s, `cult:${clan.id}`, memberId, `opened ${symbol} ${side} ${leverage}x`, 'system', id);
  autoFollow(s, clan, memberId, symbol, side, leverage);
}

// Auto-follow, as the backend does it: if you follow this cult, the trade is
// copied into your account, sized by your limits (a share of your balance, up
// to a dollar cap per trade) at the leader's leverage. It sits pending for the
// opt-out window, during which Skip undoes it. A market you already hold is
// left alone.
function autoFollow(s: State, clan: Clan, leaderId: string, symbol: string, side: 'long' | 'short', leverage: number) {
  const limits = clan.myPolicy;
  if (!clan.autoFollow || !limits?.enabled || s.positions.some(p => p.symbol === symbol)) return;
  const bal = s.me.balances!;
  const available = bal.walletUsd + (bal.perplMarginUsd ?? 0);
  const margin = Math.floor(Math.min(limits.maxUsdPerTrade, available * limits.balancePercentCap / 100) * 100) / 100;
  if (margin < 1) return;
  const fromMargin = Math.min(bal.perplMarginUsd ?? 0, margin);
  bal.perplMarginUsd = (bal.perplMarginUsd ?? 0) - fromMargin;
  bal.walletUsd = Math.max(0, bal.walletUsd - (margin - fromMargin));
  const ratio = priceOf(symbol) / baseOf(s, symbol);
  const id = `mk-${++s.next}`;
  s.positions.unshift({ symbol, side, entryRatio: ratio, margin, leverage, openedAt: Date.now(), autoSeed: id, fromMargin });
  s.seeds.push({ id, cultId: clan.id, memberId: ME_ID, symbol, origin: 'auto_mirror', side, entryRatio: ratio, notional: margin * leverage, leverage, openedAgoMin: 0, tp: null, sl: null, suggestions: [], skipUntil: new Date(Date.now() + 30_000).toISOString() });
  post(s, `cult:${clan.id}`, ME_ID, `auto-copied ${person(leaderId).name}'s ${symbol} ${side} ${leverage}x with $${margin.toFixed(2)}`, 'system', id);
}

function holdingOf(s: State, pos: Position): Holding {
  const listing = resolveListing(pos.symbol);
  const mark = priceOf(pos.symbol);
  const entry = baseOf(s, pos.symbol) * pos.entryRatio;
  const notional = pos.margin * pos.leverage;
  const perp = pos.side !== 'buy';
  const pnl = perp ? (pos.side === 'short' ? -1 : 1) * (mark - entry) / entry * notional : null;
  return {
    venue: perp ? 'perpl' : 'nadfun', market: listing?.id ?? pos.symbol, symbol: pos.symbol, side: pos.side,
    sizeRaw: String(Math.round(notional / entry * 1e6)), size: notional / entry, entryPriceAusd: entry, markPriceAusd: mark,
    valueAusd: perp ? pos.margin + (pnl ?? 0) : notional * mark / entry, pnlAusd: pnl, leverage: pos.leverage,
  };
}

function withLastMessages(s: State): Me {
  const rooms = s.me.rooms.map(room => ({ ...room, lastMessage: s.messages[room.id]?.at(-1) ?? null }));
  return { ...s.me, rooms, balances: s.me.balances && { ...s.me.balances, monUsd: s.me.balances.mon * 0.42 } };
}

function post(s: State, room: string, memberId: string, body: string, kind: ChatMessage['kind'], markerId: string | null = null, replyTo: string | null = null): ChatMessage {
  const p = person(memberId);
  const name = memberId === ME_ID ? s.me.name : p.name;
  const message: ChatMessage = { id: `msg-${++s.next}`, room, kind, clanId: room.startsWith('cult:') ? room.slice(5) : null, memberId, memberName: name, memberAvatarUrl: memberId === ME_ID ? s.me.avatarUrl : p.avatar, body, text: kind === 'system' ? `${name} ${body}` : body, replyTo, markerId, createdAt: new Date().toISOString() };
  (s.messages[room] ??= []).push(message);
  return message;
}

async function snapshot(s: State, cultId: string, marketId: string | null, resolution: number): Promise<ChartSnapshot> {
  const clan = s.me.clans.find(c => c.id === cultId) ?? s.me.clans[0]!;
  const seeds = s.seeds.filter(x => x.cultId === clan.id);
  const symbols = [...new Set(['BTC-PERP', 'ETH-PERP', 'SOL-PERP', ...seeds.map(x => x.symbol)])];
  const markets = symbols.map(resolveListing).filter((x): x is MarketListing => !!x).map(toMarket);
  const requested = marketId ? resolveListing(marketId) : null;
  const selected = requested ? toMarket(requested) : markets[0]!;
  if (requested && !markets.some(m => m.id === selected.id)) markets.push(selected);
  const fromReal = realList().some(m => m.id === selected.id && m.venue === selected.venue);
  const f = fixtureBy(selected.id);
  const candles = fromReal ? await realCandles(selected.id, resolution) ?? [] : f ? makeCandles(f, resolution) : [];
  return {
    clan, markets, selectedMarket: selected, candles, markers: seeds.map(seed => materialize(s, seed)),
    members: (s.members[clan.id] ?? [ME_ID]).map(memberOf), asOf: new Date().toISOString(), autoMirrorOptOutWindowSeconds: 30,
  };
}

function leaderboard(s: State, scope: string, cultId?: string): Leaderboard {
  const ids = scope === 'cult' ? (s.members[cultId ?? ''] ?? [ME_ID]) : scope === 'country' ? [ME_ID, ...PEOPLE.filter(p => p.country === 'NG').map(p => p.id)] : [ME_ID, ...PEOPLE.map(p => p.id)];
  const rows = ids.map(id => ({ id, stats: id === ME_ID ? myStats() : statsFor(id) })).sort((a, b) => (b.stats.realizedPnlUsd ?? 0) - (a.stats.realizedPnlUsd ?? 0));
  const entries: LeaderboardEntry[] = rows.map((row, i) => {
    const p = person(row.id);
    return { rank: i + 1, memberId: row.id, name: row.id === ME_ID ? s.me.name : p.name, avatarUrl: row.id === ME_ID ? s.me.avatarUrl : p.avatar, address: row.id === ME_ID ? DEMO_ADDRESS : addr(row.id), country: p.country, realizedPnlUsd: row.stats.realizedPnlUsd ?? 0, winRate: row.stats.winRate, tradeCount: row.stats.tradeCount, copiedTradeCount: row.stats.copied.tradeCount };
  });
  const mine = entries.find(e => e.memberId === ME_ID) ?? null;
  const name = scope === 'global' ? 'Global' : scope === 'country' ? 'Nigeria' : s.me.clans.find(c => c.id === cultId)?.name ?? 'Cult';
  return { scope, name, metric: 'realizedPnlUsd', period: 'all', entries, me: mine, rankedCount: entries.length, memberCount: entries.length + 3, asOf: new Date().toISOString() };
}

// The members you'd meet in a public cult (and do meet once you join).
const previewMembers = (cultId: string) => PEOPLE.slice(hash(cultId) % 6, (hash(cultId) % 6) + 5).map(p => p.id);

// A public cult you haven't joined: its standing spread over those members,
// per period, so the preview's totals match the Discover numbers.
function cultPreviewBoard(s: State, cultId: string, period: BoardPeriod): Leaderboard {
  const standing = standings(s).find(c => c.cultId === cultId);
  if (!standing) throw new DemoError('Cult not found.', 404);
  const r = rng(hash(cultId + 'periods'));
  const f30 = 0.25 + r() * 0.4, f7 = -0.12 + r() * 0.35;
  const share = period === 'all' ? 1 : period === '30d' ? f30 : f7;
  const tradeShare = period === 'all' ? 1 : period === '30d' ? 0.35 : 0.1;
  const ids = previewMembers(cultId);
  const w = rng(hash(cultId + 'members'));
  const weights = ids.map(() => 0.3 + w());
  const total = weights.reduce((a, b) => a + b, 0);
  const entries: LeaderboardEntry[] = ids.map((id, i) => {
    const p = person(id);
    const part = weights[i]! / total;
    return { rank: 0, memberId: id, name: p.name, avatarUrl: p.avatar, address: addr(id), country: p.country, realizedPnlUsd: Math.round(standing.realizedPnlUsd * share * part * 100) / 100, winRate: Math.min(0.92, Math.max(0.2, (standing.winRate ?? 0.5) + (w() - 0.5) * 0.24)), tradeCount: Math.max(1, Math.round(standing.tradeCount * tradeShare * part)), copiedTradeCount: 0 };
  }).sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd).map((e, i) => ({ ...e, rank: i + 1 }));
  return { scope: 'cult', name: standing.name, metric: 'realizedPnlUsd', period, entries, me: null, rankedCount: entries.length, memberCount: standing.memberCount, asOf: new Date().toISOString() };
}

function standings(s: State): CultStanding[] {
  const cults = [...s.discover, ...s.me.clans.filter(c => !s.discover.some(d => d.id === c.id)).map(c => ({ id: c.id, name: c.name, memberCount: c.memberCount, joined: true }))];
  return cults.map(c => { const r = rng(hash(c.id + 'cult')); return { cultId: c.id, name: c.name, memberCount: c.memberCount, realizedPnlUsd: Math.round(r() * 48_000 - 4_000), winRate: 0.45 + r() * 0.3, tradeCount: 40 + Math.floor(r() * 600), joined: s.me.clans.some(x => x.id === c.id) }; })
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd).map((c, i) => ({ ...c, rank: i + 1 }));
}

function closedTrades(memberId: string): ClosedTrade[] {
  const r = rng(hash(memberId + 'closed'));
  const symbols = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', '$MOE', 'MON-PERP', '$CHOG', 'ZEC-PERP'];
  return Array.from({ length: 9 }, (_, i) => {
    const symbol = symbols[Math.floor(r() * symbols.length)]!;
    const perp = !symbol.startsWith('$');
    const returnPct = Math.round((r() * 70 - 22) * 10) / 10;
    const entry = priceOf(symbol) * (0.85 + r() * 0.3);
    const listing = resolveListing(symbol);
    return { venue: perp ? 'perpl' : 'nadfun', market: listing?.id ?? symbol, symbol, side: perp ? (r() > 0.4 ? 'long' : 'short') : 'buy', returnPct, pnlUsd: Math.round(returnPct * (5 + r() * 30)) / 1, entryPrice: entry, exitPrice: entry * (1 + returnPct / 100 / (perp ? 5 : 1)), isWin: returnPct > 0, openedAt: Date.now() - (i + 1) * 86_400_000 * 0.9, closedAt: Date.now() - (i + 1) * 86_400_000 * 0.7, openTx: `0x${hash(memberId + i).toString(16)}`, tradeId: `closed-${memberId}-${i}`, copied: r() > 0.7 };
  });
}

function profile(s: State, id: string): Profile {
  const memberId = id === 'me' ? ME_ID : id;
  const p = person(memberId);
  const mine = memberId === ME_ID;
  const openSeeds = s.seeds.filter(x => x.memberId === memberId);
  const unique = openSeeds.filter((x, i) => openSeeds.findIndex(y => y.symbol === x.symbol) === i);
  return {
    id: memberId, name: mine ? s.me.name : p.name, username: mine ? s.me.username : p.name, avatarUrl: mine ? s.me.avatarUrl : p.avatar,
    address: mine ? DEMO_ADDRESS : addr(memberId), country: mine ? s.me.country : { code: p.country, name: null },
    memberSince: Date.now() - 86_400_000 * (30 + hash(memberId) % 200), isMe: mine, record: mine ? myStats() : statsFor(memberId),
    openTrades: unique.map(x => { const m = materialize(s, x); return { tradeId: m.tradeId, markerId: m.id, venue: m.venue, market: m.marketId, symbol: x.symbol, side: x.side, leverage: x.leverage, openedAt: m.entryTime * 1000 }; }),
    closedTrades: mine ? [...(s.myClosed ?? []), ...closedTrades(memberId)] : closedTrades(memberId), cults: s.me.clans.filter(c => s.members[c.id]?.includes(memberId)).map(c => ({ id: c.id, name: c.name, visibility: c.visibility })),
  };
}

function home(): Home {
  const trades = [
    ['m-solstice', 'HYPE-PERP', 'long', 41.2, 1240], ['m-krdnl', '$CHOG', 'buy', 38.6, 220], ['m-daddy', 'ETH-PERP', 'long', 24.9, 2210],
    ['m-tunde', 'MON-PERP', 'long', 18.9, 610], ['m-tandid', 'BTC-PERP', 'short', 12.4, 880], ['m-mira', '$MOE', 'buy', 9.7, 64],
  ] as const;
  return {
    topTrades: trades.map(([memberId, symbol, side, returnPct, pnlUsd], i) => {
      const p = person(memberId); const listing = resolveListing(symbol);
      return { rank: i + 1, memberId, name: p.name, avatarUrl: p.avatar, venue: side === 'buy' ? 'nadfun' : 'perpl', market: listing?.id ?? symbol, symbol, side, returnPct, pnlUsd, closedAt: Date.now() - (i + 1) * 9_000_000, tradersIn: 2 + (hash(memberId) % 9), markerId: null, tradeId: `top-${i}`, cultId: null, openTx: `0x${hash(symbol).toString(16)}` };
    }),
    sevenDay: { trades: 23, profitUsd: 412.83, positionsOpened: 9 }, asOf: new Date().toISOString(),
  };
}

function trade(s: State, tradeId: string): TradeView {
  const seed = s.seeds.find(x => `tr-${x.id}` === tradeId);
  if (seed) {
    const m = materialize(s, seed);
    const p = person(seed.memberId);
    return { tradeId, markerId: m.id, member: { id: seed.memberId, name: m.memberName, avatarUrl: p.avatar, address: seed.memberId === ME_ID ? DEMO_ADDRESS : addr(seed.memberId) }, venue: m.venue, market: m.marketId, symbol: seed.symbol, side: seed.side, leverage: seed.leverage, openedAt: m.entryTime * 1000, openTx: null, status: 'open', closedAt: null, result: null, tradersIn: s.seeds.filter(x => x.symbol === seed.symbol && x.cultId === seed.cultId).length, youCopied: s.seeds.some(x => x.memberId === ME_ID && x.symbol === seed.symbol && x.origin !== 'leader'), cultId: seed.cultId };
  }
  const top = home().topTrades.find(x => x.tradeId === tradeId);
  const closedOwner = tradeId.startsWith('closed-') ? tradeId.slice(7, tradeId.lastIndexOf('-')) : null;
  const closed = closedOwner ? closedTrades(closedOwner).find(x => x.tradeId === tradeId) : null;
  const memberId = top?.memberId ?? closedOwner ?? ME_ID;
  const p = person(memberId);
  const symbol = top?.symbol ?? closed?.symbol ?? 'BTC-PERP';
  const returnPct = top?.returnPct ?? closed?.returnPct ?? 0;
  const entry = closed?.entryPrice ?? priceOf(symbol) / (1 + returnPct / 500);
  return { tradeId, markerId: '', member: { id: memberId, name: memberId === ME_ID ? s.me.name : p.name, avatarUrl: p.avatar, address: addr(memberId) }, venue: (top?.venue ?? closed?.venue ?? 'perpl') as Venue, market: top?.market ?? closed?.market ?? symbol, symbol, side: top?.side ?? closed?.side ?? 'long', leverage: 5, openedAt: Date.now() - 2 * 86_400_000, openTx: null, status: 'closed', closedAt: top?.closedAt ?? closed?.closedAt ?? Date.now(), result: { returnPct, pnlUsd: top?.pnlUsd ?? closed?.pnlUsd ?? 0, entryPrice: entry, exitPrice: closed?.exitPrice ?? entry * (1 + returnPct / 500), isWin: returnPct > 0 }, tradersIn: top?.tradersIn ?? 1, youCopied: closed?.copied ?? false, cultId: null };
}

export class DemoError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The router. `real` performs the same request against the backend.
export async function demoApi<T>(path: string, options: RequestInit, real: () => Promise<T>): Promise<T> {
  const s = load();
  const url = new URL(path, 'http://demo');
  const method = (options.method ?? 'GET').toUpperCase();
  const body = typeof options.body === 'string' ? JSON.parse(options.body) as Record<string, unknown> : {};
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['v1', ...]
  const [, a, b, c, d, e] = parts;
  const done = <R>(value: R) => { save(); return value as unknown as T; };
  await delay(method === 'GET' ? 120 : 420);

  // Public market data: real when reachable.
  if (method === 'GET' && a === 'markets') {
    const fromReal = await tryReal(real);
    if (fromReal) return fromReal;
    if (!b) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const venue = url.searchParams.get('venue');
      return done({ markets: FIXTURES.map(fixtureListing).filter(m => (!venue || m.venue === venue) && (!q || m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))) });
    }
    const f = fixtureBy(b);
    if (!f) throw new DemoError('Market not found.', 404);
    const resolution = Number(url.searchParams.get('resolution') ?? 3600);
    return done<MarketDetail>({ market: fixtureListing(f), candles: makeCandles(f, resolution), resolution });
  }
  if (a === 'config') {
    const cfg: BackendConfig = { chainId: 10143, venues: ['perpl', 'nadfun'], displayUnit: 'USD', monPriceAusd: 0.42, autoMirrorOptOutWindowSeconds: 30, autoFollowDefaults: { balancePercentCap: 10, maxUsdPerTrade: 50 }, mirrorPolicyBounds: null, markets: [] };
    return done(cfg);
  }
  if (a === 'usernames') return done({ available: !PEOPLE.some(p => p.name.toLowerCase() === (b ?? '').toLowerCase()) });

  if (a === 'me' && !b) { cultActivity(s); return done(withLastMessages(s)); }
  if (a === 'me' && b === 'username') { s.me = { ...s.me, name: String(body.username), username: String(body.username), needsUsername: false }; return done({ username: s.me.username, name: s.me.name }); }
  if (a === 'me' && b === 'country') {
    const code = String(body.country);
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
    s.me.country = { code, name };
    const flag = String.fromCodePoint(...[...code].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
    s.me.rooms = s.me.rooms.filter(r => r.kind !== 'country');
    s.me.rooms.splice(1, 0, { id: `country:${code}`, kind: 'country', name, icon: flag, memberCount: 40 + hash(code) % 400, lastMessage: null });
    return done({ country: { code, name }, rooms: s.me.rooms });
  }
  if (a === 'me' && b === 'avatar') { s.me.avatarUrl = method === 'DELETE' ? null : String(body.image); return done(method === 'DELETE' ? undefined : { avatarUrl: s.me.avatarUrl }); }
  if (a === 'home') return done(home());
  if (a === 'members') return done(profile(s, b ?? 'me'));
  if (a === 'trades') return done(trade(s, b ?? ''));
  if (a === 'positions' && !b) return done({ positions: s.positions.map(p => holdingOf(s, p)) });
  if (a === 'nadfun') return done({ markets: [] });
  if (a === 'perpl') return done({ step: 'ready', wallet: DEMO_ADDRESS, perplAccountId: '4821', collateralBalance: '0', minAccountOpen: '0', actions: [] });
  if (a === 'privy') return done({ signerId: 'demo', policyIds: [], capAusd: 1000, maxBuyMon: 1000, monPriceAusd: 0.42 });
  // Prediction markets: prices come from the client (live Polymarket odds).
  if (a === 'predictions') {
    const list = (s.predictions ??= []);
    const what = (p: { outcomeLabel: string; question: string; eventTitle: string }) => p.outcomeLabel === p.question ? `"${p.question}"` : `${p.outcomeLabel} in "${p.eventTitle}"`;
    if (b === 'positions') return done({ positions: list, closed: s.predictionHistory ?? [] });
    if (b === 'orders' && method === 'POST') {
      const order = body as unknown as PredictionOrder;
      const price = Number(order.price), amount = Number(order.amountUsd);
      if (!(price > 0 && price < 1)) throw new DemoError('This outcome can\u2019t be bought right now.');
      if (!(amount >= 1)) throw new DemoError('The smallest bet is $1.');
      const bal = s.me.balances!;
      if (amount > bal.walletUsd + 1e-9) throw new DemoError('Not enough funds for this bet.');
      bal.walletUsd -= amount;
      const shares = amount / price;
      const existing = list.find(p => p.marketId === order.marketId && p.side === order.side);
      let position: PredictionPosition;
      if (existing) { existing.shares += shares; existing.costUsd += amount; existing.avgPrice = existing.costUsd / existing.shares; position = existing; }
      else {
        position = { id: `pp-${++s.next}`, marketId: order.marketId, eventSlug: order.eventSlug, eventTitle: order.eventTitle, outcomeLabel: order.outcomeLabel, question: order.question, image: order.image, side: order.side, sideLabel: order.sideLabel, shares, avgPrice: price, costUsd: amount, openedAt: Date.now() };
        list.unshift(position);
      }
      const cultIds = Array.isArray(order.cultIds) ? order.cultIds : s.me.clans.map(c => c.id);
      for (const cultId of cultIds) post(s, `cult:${cultId}`, ME_ID, `bet ${order.sideLabel.toUpperCase()} on ${what(order)} at ${cents(price)}`, 'system');
      return done(position);
    }
    if (b === 'sell' && method === 'POST') {
      const position = list.find(p => p.id === body.positionId);
      if (!position) throw new DemoError('That position is already closed.', 404);
      const price = Number(body.price);
      if (!(price >= 0 && price <= 1)) throw new DemoError('No price to sell at right now.');
      const proceeds = position.shares * price;
      s.me.balances!.walletUsd += proceeds;
      s.predictions = list.filter(p => p !== position);
      for (const clan of s.me.clans) post(s, `cult:${clan.id}`, ME_ID, `sold ${position.sideLabel.toUpperCase()} on ${what(position)} at ${cents(price)}`, 'system');
      const sale: PredictionSale = { position, price, proceedsUsd: proceeds, pnlUsd: proceeds - position.costUsd };
      (s.predictionHistory ??= []).unshift({ ...sale, closedAt: Date.now() });
      return done(sale);
    }
    if (b === 'bets' && method === 'POST') {
      // Cult-mates' bets, steady for an event: who, which outcome, which side.
      const outcomes = (body.outcomes as { id: string; label: string; yesPrice: number; yesLabel: string; noLabel: string }[]).slice(0, 4);
      const seen = new Set<string>();
      const bets: PredictionBet[] = [];
      for (const clan of s.me.clans) for (const memberId of s.members[clan.id] ?? []) {
        if (memberId === ME_ID || seen.has(memberId) || !outcomes.length) continue;
        seen.add(memberId);
        const r = rng(hash(String(body.eventSlug) + memberId));
        if (r() < 0.4) continue;
        const outcome = outcomes[Math.floor(r() * Math.min(outcomes.length, 3))]!;
        const yes = r() < 0.62;
        const now = yes ? outcome.yesPrice : 1 - outcome.yesPrice;
        const p = person(memberId);
        bets.push({ memberId, memberName: p.name, avatarUrl: p.avatar, cultName: clan.name, marketId: outcome.id, outcomeLabel: outcome.label,
          side: yes ? 'yes' : 'no', sideLabel: yes ? outcome.yesLabel : outcome.noLabel,
          shares: Math.round(40 + r() * 900), avgPrice: Math.min(0.97, Math.max(0.02, now * (0.72 + r() * 0.45))) });
      }
      return done({ bets });
    }
  }
  // Cross-chain (Aurora Intents): sample networks, and transfers that settle
  // about 20 seconds after they start (deposits credit wallet dollars).
  if (a === 'intents') {
    const swaps = (s.swaps ??= {});
    const chains = DEMO_CHAINS;
    const coin = (assetId: string) => chains.flatMap(c => c.tokens.map(t => ({ ...t, chain: c }))).find(t => t.assetId === assetId);
    const address = (kind: string) => `${kind === 'deposit' ? 'demo' : 'out'}${Array.from({ length: 6 }, () => Math.floor(Math.random() * 2 ** 32).toString(36)).join('')}`.slice(0, 40);
    if (b === 'chains') return done({ enabled: true, chains });
    if (b === 'deposit' && method === 'POST') {
      const t = coin(String(body.originAsset));
      const amount = Number(body.amount);
      if (!t) throw new DemoError('That coin is not supported for cross-chain transfers.', 404);
      if (!(amount > 0)) throw new DemoError('Enter an amount.');
      const usd = amount * (t.priceUsd ?? 1) * 0.997;
      const depositAddress = address('deposit');
      swaps[depositAddress] = { kind: 'deposit', usd, at: Date.now(), sent: true, credited: false, symbol: t.symbol, receive: usd.toFixed(2), receiveSymbol: 'USDC', chainName: t.chain.name };
      return done({ depositAddress, depositMemo: null, kind: 'deposit', chain: t.chain.chain, chainName: t.chain.name, symbol: t.symbol, amountIn: String(amount), amountInUsd: amount * (t.priceUsd ?? 1), receive: usd.toFixed(2), receiveSymbol: 'USDC', receiveUsd: usd, minReceive: '0', seconds: 60, deadline: new Date(Date.now() + 2 * 3_600_000).toISOString(), status: 'PENDING_DEPOSIT' });
    }
    if (b === 'withdraw' && method === 'POST') {
      const t = coin(String(body.destinationAsset));
      const usd = Number(body.amountUsd);
      if (!t) throw new DemoError('That coin is not supported for cross-chain transfers.', 404);
      if (!(usd >= 5)) throw new DemoError('The smallest cross-chain withdrawal is $5.');
      if (usd > s.me.balances!.walletUsd + 1e-9) throw new DemoError('More than you have available.');
      const receive = (usd * 0.996 / (t.priceUsd ?? 1)).toPrecision(5);
      const depositAddress = address('withdraw');
      swaps[depositAddress] = { kind: 'withdraw', usd, at: Date.now(), sent: false, credited: false, symbol: 'USDC', receive, receiveSymbol: t.symbol, chainName: t.chain.name };
      return done({ depositAddress, depositMemo: null, kind: 'withdraw', chain: t.chain.chain, chainName: t.chain.name, symbol: 'USDC', amountIn: usd.toFixed(2), amountInUsd: usd, receive, receiveSymbol: t.symbol, receiveUsd: usd * 0.996, minReceive: '0', seconds: 60, deadline: new Date(Date.now() + 3_600_000).toISOString(), status: 'PENDING_DEPOSIT', actions: [] });
    }
    if (b === 'submit' && method === 'POST') {
      const sw = swaps[String(body.depositAddress)];
      if (sw && !sw.sent) { sw.sent = true; sw.at = Date.now(); s.me.balances!.walletUsd = Math.max(0, s.me.balances!.walletUsd - sw.usd); }
      return done(undefined);
    }
    if (b === 'status' && c) {
      const sw = swaps[c];
      if (!sw) throw new DemoError('Unknown transfer.', 404);
      if (sw.kind === 'withdraw' && !sw.sent) { sw.sent = true; sw.at = Date.now(); s.me.balances!.walletUsd = Math.max(0, s.me.balances!.walletUsd - sw.usd); }
      const age = Date.now() - sw.at;
      const status = age < 8000 ? (sw.kind === 'deposit' ? 'PENDING_DEPOSIT' : 'KNOWN_DEPOSIT_TX') : age < 20000 ? 'PROCESSING' : 'SUCCESS';
      if (status === 'SUCCESS' && sw.kind === 'deposit' && !sw.credited) { sw.credited = true; s.me.balances!.walletUsd += sw.usd; }
      return done({ status, done: status === 'SUCCESS', received: status === 'SUCCESS' ? sw.receive : null, receivedUsd: status === 'SUCCESS' ? sw.usd : null, refunded: null, refundReason: null, txs: [] });
    }
    if (b === 'swaps') return done({ swaps: [] });
  }
  if (a === 'wallet' && b === 'withdraw' && method === 'POST') {
    const bal = s.me.balances!;
    const amount = Number(body.amount), to = String(body.to ?? ''), symbol = body.symbol as WithdrawRequest['symbol'];
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new DemoError('Enter a valid Monad address.');
    if (!(amount > 0)) throw new DemoError('Enter an amount.');
    const available = symbol === 'MON' ? Math.max(0, bal.mon - bal.gasReserveMon) : symbol === 'AUSD' ? bal.walletUsd : 0;
    if (amount > available + 1e-9) throw new DemoError('More than you have available.');
    if (symbol === 'MON') bal.mon -= amount; else bal.walletUsd -= amount;
    const tx = '0x' + Array.from({ length: 8 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0')).join('');
    return done<WithdrawResult>({ symbol, amount, to, tx });
  }
  if (a === 'wallet') {
    const bal = s.me.balances!;
    const info: DepositInfo = { address: DEMO_ADDRESS, network: { name: 'Monad Testnet', chainId: 10143 }, tokens: [
      { symbol: 'MON', name: 'Monad', what: 'Gas and meme buys', balance: bal.mon, balanceUsd: bal.mon * 0.42 },
      { symbol: 'USDC', name: 'USD Coin', what: 'Converted to AUSD automatically', balance: 0, balanceUsd: 0 },
      { symbol: 'AUSD', name: 'Agora Dollar', what: 'Dollars you trade with', balance: bal.walletUsd, balanceUsd: bal.walletUsd },
    ], tradingAccountUsd: bal.perplMarginUsd, totalUsd: bal.walletUsd + (bal.perplMarginUsd ?? 0) + bal.mon * 0.42 };
    return done(info);
  }

  // Trading
  if (a === 'positions' && b === 'open') {
    const listing = resolveListing(String(body.marketId));
    if (!listing) throw new DemoError('Market not found.', 404);
    const side = body.side as Holding['side'];
    const margin = Number(body.marginUsd);
    const leverage = side === 'buy' ? 1 : Number(body.leverage ?? 1);
    const bal = s.me.balances!;
    if (margin > bal.walletUsd + (bal.perplMarginUsd ?? 0) + bal.mon * 0.42) throw new DemoError('Not enough funds for this trade.');
    if (side === 'buy') bal.walletUsd = Math.max(0, bal.walletUsd - margin);
    else { const fromMargin = Math.min(bal.perplMarginUsd ?? 0, margin); bal.perplMarginUsd = (bal.perplMarginUsd ?? 0) - fromMargin; bal.walletUsd = Math.max(0, bal.walletUsd - (margin - fromMargin)); }
    const ratio = priceOf(listing.symbol) / baseOf(s, listing.symbol);
    s.positions = s.positions.filter(p => p.symbol !== listing.symbol);
    s.positions.unshift({ symbol: listing.symbol, side, entryRatio: ratio, margin, leverage, openedAt: Date.now() });
    const cultIds = Array.isArray(body.cultIds) ? body.cultIds as string[] : s.me.clans.map(c => c.id);
    s.seeds = s.seeds.filter(x => !(x.memberId === ME_ID && x.symbol === listing.symbol));
    for (const cultId of cultIds) {
      const id = `mk-${++s.next}`;
      s.seeds.push({ id, cultId, memberId: ME_ID, symbol: listing.symbol, origin: 'leader', side, entryRatio: ratio, notional: margin * leverage, leverage, openedAgoMin: 0, tp: null, sl: null, suggestions: [] });
      post(s, `cult:${cultId}`, ME_ID, side === 'buy' ? `bought ${listing.symbol}` : `opened ${listing.symbol} ${side} ${leverage}x`, 'system', id);
    }
    const fill: Fill = { venue: listing.venue, market: listing.id, side, sizeRaw: '0', size: margin * leverage / priceOf(listing.symbol), priceAusd: priceOf(listing.symbol), notionalAusd: margin * leverage, txHash: null };
    return done(fill);
  }
  if (a === 'positions' && b === 'close') {
    const listing = resolveListing(String(body.marketId));
    const symbol = listing?.symbol ?? String(body.marketId);
    const pos = s.positions.find(p => p.symbol === symbol);
    if (!pos) {
      s.seeds = s.seeds.filter(x => !(x.memberId === ME_ID && x.symbol === symbol));
      return done({ venue: listing?.venue ?? 'perpl', market: listing?.id ?? symbol, side: 'long', sizeRaw: '0', size: 0, priceAusd: priceOf(symbol), notionalAusd: 0 });
    }
    const h = holdingOf(s, pos);
    const share = body.sizeRaw ? Math.min(1, Math.max(0, Number(body.sizeRaw) / Number(h.sizeRaw))) : 1;
    const all = share >= 0.999;
    const proceeds = h.valueAusd * share;
    const bal = s.me.balances!;
    if (pos.side === 'buy') bal.walletUsd += proceeds; else bal.perplMarginUsd = (bal.perplMarginUsd ?? 0) + proceeds;
    const cost = pos.margin * share;
    const pnl = proceeds - cost;
    const returnPct = cost > 0 ? Math.round((pnl / cost) * 1000) / 10 : 0;
    (s.myClosed ??= []).unshift({ venue: h.venue, market: h.market, symbol, side: pos.side, returnPct, pnlUsd: Math.round(pnl * 100) / 100, entryPrice: h.entryPriceAusd, exitPrice: h.markPriceAusd, isWin: pnl > 0, openedAt: pos.openedAt, closedAt: Date.now(), openTx: `0xdemo${(++s.next).toString(16)}`, tradeId: null, copied: false });
    const mine = s.seeds.filter(x => x.memberId === ME_ID && x.symbol === symbol);
    const part = `${Math.round(share * 100)}% of `;
    for (const seed of mine) post(s, `cult:${seed.cultId}`, ME_ID, seed.side === 'buy' ? `sold ${all ? 'all ' : part}${symbol}` : `closed ${all ? '' : part}${symbol} ${seed.side}`, 'system');
    if (all) {
      s.positions = s.positions.filter(p => p !== pos);
      s.seeds = s.seeds.filter(x => !(x.memberId === ME_ID && x.symbol === symbol));
    } else {
      pos.margin -= cost;
      for (const seed of mine) seed.notional *= 1 - share;
    }
    const closedRaw = String(Math.round(Number(h.sizeRaw) * share));
    return done({ venue: h.venue, market: h.market, side: pos.side, sizeRaw: closedRaw, size: h.size * share, priceAusd: h.markPriceAusd, notionalAusd: h.size * share * h.markPriceAusd });
  }
  if (a === 'positions' && b === 'tpsl') {
    const listing = resolveListing(String(body.marketId));
    for (const seed of s.seeds.filter(x => x.memberId === ME_ID && x.symbol === listing?.symbol)) {
      if ('takeProfit' in body) seed.tp = body.takeProfit == null ? null : Number(body.takeProfit);
      if ('stopLoss' in body) seed.sl = body.stopLoss == null ? null : Number(body.stopLoss);
    }
    return done({ takeProfit: body.takeProfit ?? null, stopLoss: body.stopLoss ?? null });
  }
  if (a === 'shares') return done({ id: 'demo', url: '/share/demo' });

  // Chat
  if (a === 'chat' && b === 'rooms') return done({ rooms: withLastMessages(s).rooms });
  if (a === 'chat' && b && c === 'messages') {
    if (method === 'POST') { const m = post(s, b, ME_ID, String(body.body), 'text', (body.markerId as string) ?? null, (body.replyTo as string) ?? null); return done(m); }
    const list = s.messages[b] ?? [];
    return done<ChatPage>({ messages: list.slice(-50), hasMore: false, pinned: s.pinned[b] ?? null });
  }
  if (a === 'chat' && b && c === 'pin') {
    const m = (s.messages[b] ?? []).find(x => x.id === body.messageId);
    s.pinned[b] = m ? { id: m.id, memberName: m.memberName, body: m.body } : null;
    return done({ pinned: s.pinned[b] });
  }

  // Leaderboards & discovery
  if (a === 'leaderboards' && b === 'cults') return done({ entries: standings(s), asOf: new Date().toISOString() });
  if (a === 'leaderboards') return done(leaderboard(s, b ?? 'global'));
  if (a === 'cults' && b === 'discover') return done({ cults: s.discover.map(x => ({ ...x, joined: s.me.clans.some(c => c.id === x.id) })) });

  // Cults
  if (a === 'cults' && !b && method === 'POST') {
    const name = String(body.name);
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cult'}-${++s.next}`;
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const code = Array.from({ length: 6 }, (_, i) => letters[(hash(id) >> (i * 4)) % letters.length]).join('');
    const clan: Clan = { id, name, inviteCode: `${code.slice(0, 3)}-${code.slice(3)}`, visibility: body.visibility === 'public' ? 'public' : 'private', isOwner: true, memberCount: 1, myPolicy: policy(false), autoFollow: false };
    s.me.clans.push(clan);
    s.members[id] = [ME_ID];
    s.me.rooms.push({ id: `cult:${id}`, kind: 'cult', name, icon: name.trim()[0]?.toUpperCase() ?? 'C', memberCount: 1, lastMessage: null });
    post(s, `cult:${id}`, ME_ID, 'created the cult', 'system');
    if (clan.visibility === 'public') s.discover.push({ id, name, visibility: 'public', memberCount: 1, createdAt: new Date().toISOString(), joined: true });
    return done(clan);
  }
  if (a === 'cults' && b === 'join' && c === 'challenge') { const id = `ch-${++s.next}`; s.challenges[id] = body.policy as MirrorPolicy; return done({ message: 'Join cult', challengeId: id }); }
  if (a === 'cults' && b === 'join') {
    const target = body.cultId ? s.discover.find(x => x.id === body.cultId) : null;
    const code = String(body.inviteCode ?? '');
    const existing = s.me.clans.find(x => x.id === body.cultId || x.inviteCode === code);
    if (existing) return done(existing);
    const id = target?.id ?? `invited-${code.toLowerCase()}`;
    const name = target?.name ?? `Cult ${code}`;
    const clan: Clan = { id, name, inviteCode: code || 'INV-ITE', visibility: target ? 'public' : 'private', isOwner: false, memberCount: (target?.memberCount ?? 5) + 1, myPolicy: policy(false), autoFollow: false };
    s.me.clans.push(clan);
    s.members[id] = [ME_ID, ...previewMembers(id)];
    s.me.rooms.push({ id: `cult:${id}`, kind: 'cult', name, icon: name[0]!.toUpperCase(), memberCount: clan.memberCount, lastMessage: null });
    const leader = s.members[id]![1]!;
    s.seeds.push({ id: `mk-${++s.next}`, cultId: id, memberId: leader, symbol: 'ETH-PERP', origin: 'leader', side: 'long', entryRatio: 0.985, notional: 3000, leverage: 5, openedAgoMin: 200, tp: null, sl: null, suggestions: [] });
    post(s, `cult:${id}`, leader, 'opened ETH-PERP long 5x', 'system', `mk-${s.next}`);
    post(s, `cult:${id}`, ME_ID, 'joined the group', 'system');
    return done(clan);
  }
  if (a === 'cults' && b && c === 'leaderboard' && !s.me.clans.some(x => x.id === b)) {
    const period = url.searchParams.get('period');
    return done(cultPreviewBoard(s, b, period === '7d' || period === '30d' ? period : 'all'));
  }
  if (a === 'cults' && b) {
    const clan = s.me.clans.find(x => x.id === b);
    if (!clan) throw new DemoError('Cult not found.', 404);
    if (c === 'chart') return done(await snapshot(s, b, url.searchParams.get('marketId'), Number(url.searchParams.get('resolution') ?? 300)));
    if (c === 'leaderboard') return done(leaderboard(s, 'cult', b));
    if (c === 'policy' && d === 'challenge') { const id = `ch-${++s.next}`; s.challenges[id] = body.policy as MirrorPolicy; return done({ message: 'Sign your auto-follow limits', challengeId: id }); }
    if (c === 'policy') { const p = s.challenges[String(body.challengeId)] ?? policy(true); clan.myPolicy = p; clan.autoFollow = p.enabled; return done(clan); }
    if (c === 'auto-follow') { clan.autoFollow = false; clan.myPolicy = clan.myPolicy && { ...clan.myPolicy, enabled: false }; return done(clan); }
    if (c === 'visibility') { clan.visibility = body.visibility === 'public' ? 'public' : 'private'; return done(clan); }
    if (c === 'leave') {
      s.me.clans = s.me.clans.filter(x => x.id !== b);
      s.me.rooms = s.me.rooms.filter(x => x.id !== `cult:${b}`);
      s.seeds = s.seeds.filter(x => !(x.cultId === b && x.memberId === ME_ID));
      return done(undefined);
    }
    if (c === 'stack') {
      const target = s.seeds.find(x => x.id === body.markerId);
      if (!target) throw new DemoError('That position is closed.');
      const notional = Number(body.notionalUsd);
      const id = `mk-${++s.next}`;
      const ratio = priceOf(target.symbol) / baseOf(s, target.symbol);
      s.seeds.push({ ...target, id, memberId: ME_ID, origin: 'manual_stack', entryRatio: ratio, notional, openedAgoMin: 0, tp: null, sl: null, suggestions: [] });
      s.positions = s.positions.filter(p => p.symbol !== target.symbol);
      s.positions.unshift({ symbol: target.symbol, side: target.side, entryRatio: ratio, margin: notional / Math.max(1, target.leverage), leverage: target.side === 'buy' ? 1 : target.leverage, openedAt: Date.now() });
      post(s, `cult:${b}`, ME_ID, target.side === 'buy' ? `bought ${target.symbol}` : `opened ${target.symbol} ${target.side} ${target.leverage}x`, 'system', id);
      return done({ id, venue: target.side === 'buy' ? 'nadfun' : 'perpl', status: 'open', market: target.symbol, side: target.side, size: 0, notionalAusd: notional, leverage: target.leverage });
    }
    if (c === 'markers' && e === 'suggest-tpsl') {
      const seed = s.seeds.find(x => x.id === d);
      const m = seed && materialize(s, seed);
      const suggestion: TpslSuggestion = { id: `sg-${++s.next}`, markerId: d ?? '', tradeId: `tr-${d}`, fromMemberId: ME_ID, fromName: s.me.name, takeProfitPrice: (body.takeProfit as number) ?? m?.takeProfitPrice ?? null, stopLossPrice: (body.stopLoss as number) ?? m?.stopLossPrice ?? null, createdAt: new Date().toISOString() };
      seed?.suggestions.push(suggestion);
      return done(suggestion);
    }
    if (c === 'mirrors') {
      const seed = s.seeds.find(x => x.id === d);
      if (seed) s.seeds = s.seeds.filter(x => x !== seed);
      const pos = s.positions.find(p => p.autoSeed === d);
      if (pos) {
        const bal = s.me.balances!;
        bal.perplMarginUsd = (bal.perplMarginUsd ?? 0) + (pos.fromMargin ?? 0);
        bal.walletUsd += pos.margin - (pos.fromMargin ?? 0);
        s.positions = s.positions.filter(p => p !== pos);
        post(s, `cult:${seed?.cultId ?? b}`, ME_ID, `skipped the copy of ${pos.symbol}`, 'system');
      }
      return done(undefined);
    }
  }
  throw new DemoError('Not available in the demo.', 404);
}

async function realCandles(marketId: string, resolution: number): Promise<Candle[] | null> {
  const base = process.env.NEXT_PUBLIC_CULT_API_BASE_URL?.replace(/\/$/, '');
  if (!base || realDown) return null;
  try {
    const response = await fetch(`${base}/v1/markets/${encodeURIComponent(marketId)}?resolution=${resolution}`, { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json() as MarketDetail).candles;
  } catch { return null; }
}

export const demoListings = allListings;

// Sample networks for the demo's cross-chain deposit/withdraw.
const DEMO_CHAINS = [
  { chain: 'btc', name: 'Bitcoin', evm: false, tokens: [{ assetId: 'nep141:btc.omft.near', symbol: 'BTC', decimals: 8, priceUsd: 62000 }] },
  { chain: 'eth', name: 'Ethereum', evm: true, tokens: [{ assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', symbol: 'USDC', decimals: 6, priceUsd: 1 }, { assetId: 'nep141:eth.omft.near', symbol: 'ETH', decimals: 18, priceUsd: 2700 }] },
  { chain: 'sol', name: 'Solana', evm: false, tokens: [{ assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', symbol: 'USDC', decimals: 6, priceUsd: 1 }, { assetId: 'nep141:sol.omft.near', symbol: 'SOL', decimals: 9, priceUsd: 150 }] },
  { chain: 'base', name: 'Base', evm: true, tokens: [{ assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', symbol: 'USDC', decimals: 6, priceUsd: 1 }, { assetId: 'nep141:base.omft.near', symbol: 'ETH', decimals: 18, priceUsd: 2700 }] },
  { chain: 'tron', name: 'Tron', evm: false, tokens: [{ assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near', symbol: 'USDT', decimals: 6, priceUsd: 1 }] },
  { chain: 'ton', name: 'TON', evm: false, tokens: [{ assetId: 'nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR', symbol: 'USDT', decimals: 6, priceUsd: 1 }] },
  { chain: 'sui', name: 'Sui', evm: false, tokens: [{ assetId: 'nep141:sui.omft.near', symbol: 'SUI', decimals: 9, priceUsd: 2.4 }] },
  { chain: 'near', name: 'NEAR', evm: false, tokens: [{ assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, priceUsd: 2.6 }] },
];
