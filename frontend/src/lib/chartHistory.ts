import type { Candle } from './contracts';

export const CHART_RESOLUTIONS = [
  { label: '1m', seconds: 60 }, { label: '5m', seconds: 300 }, { label: '15m', seconds: 900 },
  { label: '30m', seconds: 1800 }, { label: '1H', seconds: 3600 }, { label: '4H', seconds: 14400 }, { label: '1D', seconds: 86400 },
];

export function candleResolution(candles: Candle[]): number {
  let step = Infinity;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta > 0) step = Math.min(step, delta);
  }
  return CHART_RESOLUTIONS.some(r => r.seconds === step) ? step : 300;
}

export function mergeChartCandles(previous: Candle[], incoming: Candle[]): Candle[] {
  const candles = new Map<number, Candle>();
  for (const c of [...previous, ...incoming]) {
    if (!Number.isSafeInteger(c.time) || ![c.open, c.high, c.low, c.close].every(Number.isFinite)) continue;
    candles.set(c.time, c);
  }
  return [...candles.values()].sort((a, b) => a.time - b.time).slice(-12_000);
}

type LogicalRange = { from: number; to: number };

export function chartVisibleRange(previous: Candle[], next: Candle[], range: LogicalRange | null, reset: boolean): LogicalRange | null {
  if (!next.length) return null;
  if (reset || !previous.length || !range) return { from: Math.max(0, next.length - 120), to: next.length - 1 + 14 };
  // Keep the same candle under the left edge when history is prepended or trimmed.
  const index = Math.max(0, Math.min(previous.length - 1, Math.floor(range.from)));
  const time = previous[index].time;
  let nextIndex = next.findIndex(c => c.time >= time);
  if (nextIndex < 0) nextIndex = next.length - 1;
  const shift = range.to >= previous.length - 1 ? next.length - previous.length : nextIndex - index;
  return { from: range.from + shift, to: range.to + shift };
}
