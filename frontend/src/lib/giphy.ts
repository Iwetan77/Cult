// A reaction GIF for the PnL card, from GIPHY, matched to how the trade went:
// a different one each time (recent picks are skipped). Needs
// NEXT_PUBLIC_GIPHY_API_KEY; without it the card falls back to still art.

const KEY = process.env.NEXT_PUBLIC_GIPHY_API_KEY;
export const giphyEnabled = () => !!KEY;

export type GifMood = 'moon' | 'win' | 'flat' | 'loss' | 'rekt';

// By return on margin (or PnL when there's no return). Any gain celebrates and
// any loss commiserates, however small: a -0.2% card must never get a thumbs up.
// Only a trade that's exactly even shrugs.
export function moodOf(roiPct: number | null, pnlUsd: number | null): GifMood {
  const v = roiPct ?? (pnlUsd == null ? 0 : Math.sign(pnlUsd) * 10);
  if (Math.abs(v) < 0.05) return 'flat';
  return v >= 25 ? 'moon' : v > 0 ? 'win' : v > -25 ? 'loss' : 'rekt';
}

// Searches that only ever mean one thing: vague words ("why", "pain", "meh")
// bring back GIFs of anything.
const QUERIES: Record<GifMood, string[]> = {
  moon: ['money rain', 'make it rain money', 'we are rich', 'champagne celebration', 'wolf of wall street money', 'stonks', 'rich celebration', 'lambo'],
  win: ['lets go celebration', 'victory dance', 'happy dance', 'success kid', 'winning celebration', 'celebration dance', 'nailed it', 'yes celebration'],
  flat: ['shrug', 'it is what it is', 'unbothered shrug'],
  loss: ['oh no', 'facepalm', 'this is fine dog', 'disappointed face', 'sigh disappointed', 'sad face', 'bad day'],
  rekt: ['crying', 'its over', 'everything is on fire', 'mental breakdown', 'devastated crying', 'rekt'],
};

export type GifPick = { id: string; url: string; width: number; height: number; title: string };

type Rendition = { url?: string; width?: string; height?: string; size?: string };
type GiphyGif = { id: string; title: string; images: Record<string, Rendition | undefined> };

const RECENT_KEY = 'cult:pnl-gifs:recent';
const recent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; } };
const remember = (id: string) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter(x => x !== id)].slice(0, 60))); } catch { /* private mode */ } };

// Big enough to fill the card's window, small enough to load fast on a phone.
function rendition(gif: GiphyGif): GifPick | null {
  for (const name of ['downsized_medium', 'downsized', 'fixed_width']) {
    const r = gif.images[name];
    const width = Number(r?.width), height = Number(r?.height), size = Number(r?.size ?? 0);
    if (r?.url && width >= 200 && height > 0 && (!size || size <= 4_000_000)) return { id: gif.id, url: r.url, width, height, title: gif.title };
  }
  return null;
}

// Why no GIF came back, said plainly on the card (so a screenshot tells us).
export class GifError extends Error {}

// Search results are kept on the device for a while, per mood: one search
// gives 25 GIFs, so most cards need no request at all. That keeps a shared
// GIPHY key well under its hourly limit (a beta key allows ~100 searches).
// v2: the searches changed, so GIFs kept from the old ones are dropped.
const POOL_KEY = (mood: GifMood) => `cult:pnl-gifs:pool:v2:${mood}`;
const POOL_MS = 12 * 3_600_000;
type Pool = { at: number; picks: GifPick[] };
const cachedPool = (mood: GifMood): GifPick[] => {
  try {
    localStorage.removeItem(`cult:pnl-gifs:pool:${mood}`); // v1, from the old searches
    const pool = JSON.parse(localStorage.getItem(POOL_KEY(mood)) ?? 'null') as Pool | null;
    return pool && Date.now() - pool.at < POOL_MS ? pool.picks : [];
  } catch { return []; }
};
const keepPool = (mood: GifMood, picks: GifPick[]) => {
  const merged = [...new Map([...cachedPool(mood), ...picks].map(p => [p.id, p])).values()].slice(-150);
  try { localStorage.setItem(POOL_KEY(mood), JSON.stringify({ at: Date.now(), picks: merged })); } catch { /* private mode: search each time */ }
};

// Wide GIFs suit the card's wide window: the zoom that crops corner logos
// then only trims a thin strip, so bottom captions stay in view.
function choose(picks: GifPick[], avoid: Set<string>, skip: string[]): GifPick | null {
  const wide = picks.filter(p => p.width / p.height >= 1.25);
  const fresh = (wide.length ? wide : picks).filter(p => !avoid.has(p.id));
  const pool = fresh.length ? fresh : picks.filter(p => !skip.includes(p.id));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)]! : null;
}

export async function pickGif(mood: GifMood, skip: string[] = []): Promise<GifPick | null> {
  if (!KEY) return null;
  const queries = QUERIES[mood];
  const avoid = new Set([...recent(), ...skip]);
  // One not seen lately from what's kept on this device, when there's one.
  const kept = cachedPool(mood).filter(p => !avoid.has(p.id));
  if (kept.length) {
    const pick = choose(kept, avoid, skip);
    if (pick) { remember(pick.id); return pick; }
  }
  // Two tries: a random query a little way down its results (variety), then
  // any query from the top. GIPHY's matches get loose past the first dozen.
  let failure: string | null = null;
  for (const attempt of [0, 1]) {
    const q = queries[Math.floor(Math.random() * queries.length)]!;
    const offset = attempt === 0 ? Math.floor(Math.random() * 12) : 0;
    const params = new URLSearchParams({ api_key: KEY, q, limit: '25', offset: String(offset), rating: 'pg-13', lang: 'en', bundle: 'messaging_non_clips' });
    const response = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`).catch(() => null);
    if (!response) { failure = 'GIF search couldn’t be reached'; continue; }
    if (response.status === 429) throw new GifError('GIF search is busy right now (too many requests)');
    if (response.status === 401 || response.status === 403) throw new GifError('GIF search turned this app’s key down');
    if (!response.ok) { failure = `GIF search failed (${response.status})`; continue; }
    const body = await response.json().catch(() => null) as { data?: GiphyGif[] } | null;
    const picks = (body?.data ?? []).map(rendition).filter((p): p is GifPick => !!p);
    if (picks.length) keepPool(mood, picks);
    const pick = choose(picks, avoid, skip);
    if (!pick) continue;
    remember(pick.id);
    return pick;
  }
  if (failure) throw new GifError(failure);
  return null;
}
