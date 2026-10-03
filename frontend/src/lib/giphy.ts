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

export async function pickGif(mood: GifMood, skip: string[] = []): Promise<GifPick | null> {
  if (!KEY) return null;
  const queries = QUERIES[mood];
  const avoid = new Set([...recent(), ...skip]);
  // Two tries: a random query at a random depth, then any query from the top.
  for (const attempt of [0, 1]) {
    const q = queries[Math.floor(Math.random() * queries.length)]!;
    const offset = attempt === 0 ? Math.floor(Math.random() * 40) : 0;
    const params = new URLSearchParams({ api_key: KEY, q, limit: '25', offset: String(offset), rating: 'pg-13', lang: 'en', bundle: 'messaging_non_clips' });
    const response = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`).catch(() => null);
    if (!response?.ok) continue;
    const body = await response.json().catch(() => null) as { data?: GiphyGif[] } | null;
    const picks = (body?.data ?? []).map(rendition).filter((p): p is GifPick => !!p);
    const fresh = picks.filter(p => !avoid.has(p.id));
    const pool = fresh.length ? fresh : picks.filter(p => !skip.includes(p.id));
    if (!pool.length) continue;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    remember(pick.id);
    return pick;
  }
  return null;
}
