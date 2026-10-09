// A reaction GIF for the PnL card, from GIPHY, matched to how the trade went:
// a different one each time (recent picks are skipped). Needs
// NEXT_PUBLIC_GIPHY_API_KEY; without it the card falls back to still art.

const KEY = process.env.NEXT_PUBLIC_GIPHY_API_KEY;
export const giphyEnabled = () => !!KEY;

export type GifMood = 'moon' | 'win' | 'flat' | 'loss' | 'rekt';

// By return on margin (or PnL when there's no return).
export function moodOf(roiPct: number | null, pnlUsd: number | null): GifMood {
  const v = roiPct ?? (pnlUsd == null ? 0 : Math.sign(pnlUsd) * 10);
  return v >= 40 ? 'moon' : v >= 3 ? 'win' : v > -3 ? 'flat' : v > -30 ? 'loss' : 'rekt';
}

const QUERIES: Record<GifMood, string[]> = {
  moon: ['to the moon', 'we are rich', 'money rain', 'make it rain', 'lambo', 'champagne celebration', 'wolf of wall street', 'rich dance', 'stonks'],
  win: ['lets go', 'winning', 'celebration dance', 'nailed it', 'victory dance', 'success kid', 'yes yes yes', 'happy dance', 'too easy'],
  flat: ['meh', 'shrug', 'not bad', 'close enough', 'it is what it is', 'thumbs up', 'okay then'],
  loss: ['this is fine', 'oh no', 'facepalm', 'disappointed', 'sad', 'why', 'pain'],
  rekt: ['its over', 'crying', 'mental breakdown', 'everything is on fire', 'rekt', 'devastated', 'help me'],
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
const POOL_KEY = (mood: GifMood) => `cult:pnl-gifs:pool:${mood}`;
const POOL_MS = 12 * 3_600_000;
type Pool = { at: number; picks: GifPick[] };
const cachedPool = (mood: GifMood): GifPick[] => {
  try {
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
  // Two tries: a random query at a random depth, then any query from the top.
  let failure: string | null = null;
  for (const attempt of [0, 1]) {
    const q = queries[Math.floor(Math.random() * queries.length)]!;
    const offset = attempt === 0 ? Math.floor(Math.random() * 40) : 0;
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
