import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartCount, chartResolution, nadHistory, perplHistory } from '../src/api/chart-history.js';

const NOW = Date.UTC(2026, 9, 7, 12, 34, 56);
const resolutions = [60, 300, 900, 1800, 3600, 14400, 86400];
const lookbacks = [7, 30, 90, 180, 365, 1095, 1825];
const nadRes = ['1', '5', '15', '30', '60', '240', '1D'];
const unprice = (price: number) => price / 100;

function perplRange(input: string | URL | Request) {
  const url = new URL(String(input));
  const match = url.pathname.match(/\/candles\/(\d+)\/(\d+)-(\d+)$/)!;
  return { resolution: Number(match[1]), from: Number(match[2]) / 1000, to: Number(match[3]) / 1000 };
}

function perplResponse(from: number, to: number, resolution: number, close = 10500) {
  const d = [];
  for (let time = Math.ceil(from / resolution) * resolution; time <= to; time += resolution) {
    d.push({ t: time * 1000, o: 10000, h: 11000, l: 9000, c: close });
  }
  // Exercise ordering and duplicate timestamps at inclusive page boundaries.
  return Response.json({ d: [...d.reverse(), ...d.slice(0, 1)] });
}

test('Perpl history covers every supported lookback without exceeding upstream limits', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const requests: ReturnType<typeof perplRange>[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const range = perplRange(input);
    requests.push(range);
    return perplResponse(range.from, range.to, range.resolution);
  });
  for (let i = 0; i < resolutions.length; i++) {
    const resolution = resolutions[i];
    const candles = await perplHistory(`https://history.test/full-${resolution}`, 64, unprice, resolution);
    const expected = lookbacks[i] * 86400 / resolution;
    assert.equal(candles.length, expected + 1);
    assert.equal(candles[0].time, Math.floor(NOW / 1000 / resolution) * resolution - expected * resolution);
    assert.equal(candles.at(-1)!.time, Math.floor(NOW / 1000 / resolution) * resolution);
    assert.equal(candles.at(-1)!.close, 105);
    for (let n = 1; n < candles.length; n++) assert.equal(candles[n].time - candles[n - 1].time, resolution);
  }
  assert.ok(requests.every(r => (r.to - r.from) / r.resolution + 1 <= 1024));
});

test('closed history pages are reused across concurrent requests and live refreshes', async t => {
  let now = NOW;
  let close = 10500;
  t.mock.method(Date, 'now', () => now);
  const requests: ReturnType<typeof perplRange>[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const range = perplRange(input);
    requests.push(range);
    return perplResponse(range.from, range.to, range.resolution, close);
  });
  const load = () => perplHistory('https://history.test/cache', 64, unprice);
  const [first, concurrent] = await Promise.all([load(), load()]);
  assert.deepEqual(first, concurrent);
  const initialRequests = requests.length;
  assert.ok(initialRequests > 1 && initialRequests <= 10);
  assert.deepEqual(await load(), first);
  assert.equal(requests.length, initialRequests);
  now += 30_000;
  close = 10800;
  const refreshed = await load();
  assert.equal(requests.length, initialRequests + 1);
  assert.equal(refreshed[0].time, Math.floor(now / 1000 / 300) * 300 - chartCount(300) * 300);
  assert.equal(refreshed.at(-1)!.close, 108);
});

test('an inclusive Perpl page end cannot overwrite the refreshed boundary candle', async t => {
  const boundary = Math.floor(NOW / 1000 / 300000) * 300000;
  let now = (boundary + 500) * 1000;
  let close = 10500;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const range = perplRange(input);
    return perplResponse(range.from, range.to, range.resolution, close);
  });
  const load = () => perplHistory('https://history.test/boundary', 64, unprice, 300, 2000);
  await load();
  now += 30_000;
  close = 10800;
  assert.equal((await load()).find(c => c.time === boundary)!.close, 108);
});

test('Nad.fun history pages by exclusive to and bounded countback for all resolutions', async t => {
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const query = new URL(String(input)).searchParams;
    const resolution = resolutions[nadRes.indexOf(query.get('resolution')!)];
    assert.ok(resolution);
    const to = Number(query.get('to'));
    const count = Number(query.get('countback'));
    assert.ok(count >= 1 && count <= 3000);
    assert.equal(query.get('chart_type'), 'price_usd');
    // Match the documented API: ignore from, select the last count bars before to.
    const times = Array.from({ length: count }, (_, i) => (Math.ceil(to / resolution) - 1 - i) * resolution);
    return Response.json({ t: times, o: times.map(() => '0.001'), h: times.map(() => '0.002'), l: times.map(() => '0.0005'), c: times.map(() => '0.0015') });
  });
  for (let i = 0; i < resolutions.length; i++) {
    const resolution = resolutions[i];
    const candles = await nadHistory(`https://history.test/nad-${resolution}`, '0xabc', resolution);
    assert.equal(candles.length, chartCount(resolution) + 1);
    assert.equal(candles.at(-1)!.close, 0.0015);
    for (let n = 1; n < candles.length; n++) assert.equal(candles[n].time - candles[n - 1].time, resolution);
  }
});

test('sparse and empty feeds stay sparse and empty without fabricated candles', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const time = Math.floor(NOW / 1000 / 300) * 300;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const query = new URL(String(input)).searchParams;
    const to = Number(query.get('to'));
    const times = [time - 900, time].filter(value => value < to);
    return Response.json({ t: times, o: times.map(() => '1'), h: times.map(() => '2'), l: times.map(() => '0.5'), c: times.map(() => '1.5') });
  });
  assert.deepEqual((await nadHistory('https://history.test/sparse', '0xabc')).map(c => c.time), [time - 900, time]);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ d: [] }));
  assert.deepEqual(await perplHistory('https://history.test/empty', 64, unprice), []);
});

test('a failed history page preserves successful real pages and retries on the next request', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const calls = new Map<number, number>();
  const liveStart = Math.floor(NOW / 1000 / 300000) * 300000;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const range = perplRange(input);
    const call = (calls.get(range.from) ?? 0) + 1;
    calls.set(range.from, call);
    if (range.from === liveStart - 300000 && call === 1) return new Response('unavailable page', { status: 400 });
    return perplResponse(range.from, range.to, range.resolution);
  });
  const load = () => perplHistory('https://history.test/failure', 64, unprice, 300, 2500);
  const partial = await load();
  assert.ok(partial.length > 0 && partial.length < 2501);
  assert.equal(partial.at(-1)!.time, Math.floor(NOW / 1000 / 300) * 300);
  assert.equal((await load()).length, 2501);
  assert.equal(calls.get(liveStart - 300000), 2);
  assert.equal(calls.get(liveStart), 1);
});

test('explicit count and unsupported resolution remain bounded and backward compatible', async t => {
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const range = perplRange(input);
    assert.equal(range.resolution, 300);
    return perplResponse(range.from, range.to, range.resolution);
  });
  assert.equal(chartResolution(-1), 300);
  assert.equal(chartResolution(NaN), 300);
  assert.equal(chartCount(300, 1000000), 10080);
  assert.equal(chartCount(300, -10), 1);
  assert.equal((await perplHistory('https://history.test/explicit', 64, unprice, -1, 300)).length, 301);
});
