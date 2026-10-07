import { getJson } from '../http.js';

export interface Candle {
  time: number; // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

const LOOKBACK_DAYS: Record<number, number> = { 60: 7, 300: 30, 900: 90, 1800: 180, 3600: 365, 14400: 1095, 86400: 1825 };
const NAD_RES: Record<number, string> = { 60: '1', 300: '5', 900: '15', 1800: '30', 3600: '60', 14400: '240', 86400: '1D' };
const MAX_CANDLES = 10_080;
const pages = new Map<string, { expires: number; data: Promise<Candle[]> }>();

export const chartResolution = (seconds: number) => Object.hasOwn(LOOKBACK_DAYS, seconds) ? seconds : 300;
export const chartCount = (seconds: number, count?: number) => count == null || !Number.isFinite(count)
  ? Math.ceil(LOOKBACK_DAYS[chartResolution(seconds)] * 86400 / chartResolution(seconds))
  : Math.min(MAX_CANDLES, Math.max(1, Math.floor(count)));

function clean(candles: Candle[]): Candle[] {
  const unique = new Map<number, Candle>();
  for (const c of candles) {
    if (!Number.isSafeInteger(c.time) || c.time < 0 || ![c.open, c.high, c.low, c.close].every(Number.isFinite)) continue;
    if (c.low < 0 || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) continue;
    unique.set(c.time, c);
  }
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

async function history(key: string, resolution: number, count: number | undefined, pageSize: number, read: (from: number, to: number, count: number) => Promise<Candle[]>): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = Math.max(0, Math.floor(to / resolution) * resolution - chartCount(resolution, count) * resolution);
  const span = resolution * pageSize;
  const ranges: { from: number; to: number }[] = [];
  // Fixed windows let subsequent chart and marker refreshes reuse closed pages.
  for (let end = to; end > from;) {
    const start = Math.floor((end - 1) / span) * span;
    ranges.push({ from: start, to: end });
    end = start;
  }
  const load = (range: { from: number; to: number }) => {
    const live = range.to === to;
    const pageKey = `${key}:${resolution}:${range.from}:${live ? 'live' : range.to}`;
    const hit = pages.get(pageKey);
    if (hit && hit.expires > Date.now()) return hit.data;
    if (hit) pages.delete(pageKey);
    while (pages.size >= 128) pages.delete(pages.keys().next().value!);
    const data = read(range.from, range.to, Math.min(pageSize, Math.ceil((range.to - range.from) / resolution))).then(clean);
    const entry = { expires: Date.now() + (live ? 10_000 : 6 * 60 * 60 * 1000), data };
    pages.set(pageKey, entry);
    void data.catch(() => { if (pages.get(pageKey) === entry) pages.delete(pageKey); });
    return data;
  };
  const candles: Candle[] = [];
  let failure: unknown;
  // Bound cold-load concurrency and retain real pages if one upstream page fails.
  for (let i = 0; i < ranges.length; i += 3) {
    const results = await Promise.allSettled(ranges.slice(i, i + 3).map(load));
    for (const result of results) {
      if (result.status === 'fulfilled') candles.push(...result.value);
      else failure = result.reason;
    }
  }
  if (!candles.length && failure) throw failure;
  return clean(candles).filter(c => c.time >= from && c.time <= to);
}

export function perplHistory(base: string, marketId: number, unprice: (value: number) => number, seconds = 300, count?: number): Promise<Candle[]> {
  const resolution = chartResolution(seconds);
  return history(`${base}:${marketId}`, resolution, count, 1000, async (from, to) => {
    const body = await getJson<{ d: { t: number; o: number; h: number; l: number; c: number }[] }>(
      `${base}/v1/market-data/${marketId}/candles/${resolution}/${from * 1000}-${to * 1000}`,
    );
    return (body.d ?? []).map(c => ({ time: Math.floor(c.t / 1000), open: unprice(c.o), high: unprice(c.h), low: unprice(c.l), close: unprice(c.c) }))
      .filter(c => c.time >= from && c.time < to);
  });
}

export function nadHistory(base: string, token: string, seconds = 300, count?: number): Promise<Candle[]> {
  const resolution = chartResolution(seconds);
  return history(`${base}:${token.toLowerCase()}`, resolution, count, 3000, async (from, to, countback) => {
    const query = new URLSearchParams({ resolution: NAD_RES[resolution], from: String(from), to: String(to), countback: String(countback), chart_type: 'price_usd' });
    const body = await getJson<{ t: number[]; o: string[]; h: string[]; l: string[]; c: string[] }>(`${base}/trade/chart/${token}?${query}`);
    // The upstream queries strictly before `to`; `from` alone does not limit it.
    return (body.t ?? []).map((time, i) => ({ time, open: Number(body.o[i]), high: Number(body.h[i]), low: Number(body.l[i]), close: Number(body.c[i]) }))
      .filter(c => c.time >= from && c.time < to);
  });
}
