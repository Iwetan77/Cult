import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candleResolution, chartVisibleRange, mergeChartCandles } from '../src/lib/chartHistory';

const candle = (time: number, close = 10) => ({ time, open: 10, high: 12, low: 8, close });
const data = (count: number, start = 0, step = 300) => Array.from({ length: count }, (_, i) => candle(start + i * step));

test('expanded history opens on recent readable candles, including after an empty initial load', () => {
  assert.equal(chartVisibleRange([], [], null, true), null);
  assert.deepEqual(chartVisibleRange([], data(8641), { from: 0, to: 10000 }, false), { from: 8521, to: 8654 });
  assert.deepEqual(chartVisibleRange([], data(80), null, false), { from: 0, to: 93 });
});

test('market or resolution reset returns to recent data instead of the old logical indexes', () => {
  assert.deepEqual(chartVisibleRange(data(8641), data(239, 0, 86400), { from: 8500, to: 8600 }, true), { from: 119, to: 252 });
});

test('historical pan and zoom survive live refreshes and candle/line replacements', () => {
  const candles = data(300);
  const range = { from: 25.5, to: 75.5 };
  assert.deepEqual(chartVisibleRange(candles, candles, range, false), range);
  assert.deepEqual(chartVisibleRange(candles, [...candles, candle(90000)], range, false), range);
});

test('prepending or trimming history preserves the same historical candle under the viewport', () => {
  const candles = data(300, 90000);
  assert.deepEqual(chartVisibleRange(candles, [...data(300), ...candles], { from: 25.5, to: 75.5 }, false), { from: 325.5, to: 375.5 });
  assert.deepEqual(chartVisibleRange(candles, candles.slice(10), { from: 25.5, to: 75.5 }, false), { from: 15.5, to: 65.5 });
});

test('live edge follows a new candle while retaining zoom and right padding', () => {
  const candles = data(300);
  assert.deepEqual(chartVisibleRange(candles, [...candles, candle(90000)], { from: 180, to: 313 }, false), { from: 181, to: 314 });
});

test('short or empty refreshes retain loaded history and update real candles by timestamp', () => {
  const candles = data(300);
  assert.deepEqual(mergeChartCandles(candles, []), candles);
  const merged = mergeChartCandles(candles, [candle(89700, 11), candle(90000)]);
  assert.equal(merged.length, 301);
  assert.equal(merged[0].time, 0);
  assert.equal(merged.at(-2)!.close, 11);
  assert.equal(merged.at(-1)!.time, 90000);
});

test('series data is unique, chronological and finite while allowing real gaps', () => {
  const merged = mergeChartCandles([], [candle(900), candle(0), candle(900, 11), candle(1200, NaN)]);
  assert.deepEqual(merged.map(c => c.time), [0, 900]);
  assert.equal(merged[1].close, 11);
  assert.equal(candleResolution(data(3, 0, 86400)), 86400);
  assert.equal(candleResolution(data(3, 0, 3600)), 3600);
});
