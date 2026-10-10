import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combinedMarketHolding, holdingClosedByFill, holdingForMarker, holdingForTrade, holdingIdentity, positionCloseBody, positionCloseSizeRaw, closePosition } from '../src/lib/api';
import { isLeaderTradeMarker, type Fill, type Holding } from '../src/lib/contracts';
import { resultOfClose } from '../src/lib/pnlCard';

const lot = (markerId: string, tradeId?: string, origin: Holding['origin'] = 'leader'): Holding => ({
  venue: 'perpl', market: 'BTC', symbol: 'BTC-PERP', side: 'long', sizeRaw: '1000', size: 10,
  entryPriceAusd: 100, markPriceAusd: 120, valueAusd: 1200, pnlAusd: 200, leverage: 2,
  markerId, tradeId, origin, cultIds: origin === 'private' ? [] : ['cult-a'], isNetted: true,
});
const leader = lot('trade:one', 'one');
const second = lot('trade:two', 'two');
const mirror = lot('mirror:copy', 'copy', 'auto_mirror');
const manual = lot('mirror:manual', 'manual', 'manual_stack');
const residual = lot('private:BTC', undefined, 'private');
const holdings = [leader, second, mirror, manual, residual];

test('lot close requests retain the exact leader, copy and private residual marker', () => {
  for (const holding of holdings) {
    assert.deepEqual(positionCloseBody(holding.market, positionCloseSizeRaw(holding, 1), holding.markerId), { marketId: 'BTC', markerId: holding.markerId });
    assert.deepEqual(positionCloseBody(holding.market, positionCloseSizeRaw(holding, 0.25), holding.markerId), { marketId: 'BTC', markerId: holding.markerId, sizeRaw: '250' });
  }
});

test('account matching uses trade identity and never falls back to another lot on the market', () => {
  assert.equal(holdingForTrade(holdings, { tradeId: 'two', market: 'btc', venue: 'perpl' }), second);
  assert.equal(holdingForTrade(holdings, { tradeId: 'copy', market: 'BTC', venue: 'perpl' }), mirror);
  assert.equal(holdingForTrade(holdings, { tradeId: 'missing', market: 'BTC', venue: 'perpl' }), undefined);
  assert.equal(holdingForTrade(holdings, { tradeId: 'two', market: 'BTC', venue: 'nadfun' }), undefined);
});

test('chart matching uses the selected marker, including private residuals, without a market fallback', () => {
  for (const holding of holdings) assert.equal(holdingForMarker(holdings, { id: holding.markerId!, marketId: 'BTC', venue: 'perpl' }), holding);
  assert.equal(holdingForMarker(holdings, { id: 'trade:missing', marketId: 'BTC', venue: 'perpl' }), undefined);
  assert.equal(holdingForMarker(holdings, { id: leader.markerId!, marketId: 'ETH', venue: 'perpl' }), undefined);
  assert.equal(new Set(holdings.map(holdingIdentity)).size, 5);
});

test('explicit Close all combines all market lots and omits every lot identity', () => {
  const combined = combinedMarketHolding([...holdings, { ...lot('trade:other'), market: 'ETH' }, { ...lot('trade:spot'), venue: 'nadfun' }], 'btc', 'perpl')!;
  assert.equal(combined.sizeRaw, '5000');
  assert.equal(combined.size, 50);
  assert.equal(combined.valueAusd, 6000);
  assert.equal(combined.pnlAusd, 1000);
  assert.equal(combined.entryPriceAusd, 100);
  assert.equal(combined.markerId, undefined);
  assert.equal(combined.tradeId, undefined);
  assert.deepEqual(positionCloseBody(combined.market), { marketId: 'BTC' });
  assert.equal(combinedMarketHolding(holdings, 'ETH', 'perpl'), undefined);
});

test('combined holdings respect signed net exposure and unknown cost basis', () => {
  const combined = combinedMarketHolding([leader, { ...second, side: 'short', size: 4, sizeRaw: '400', valueAusd: 480 }], 'BTC', 'perpl')!;
  assert.equal(combined.sizeRaw, '600');
  assert.equal(combined.size, 6);
  assert.equal(combined.valueAusd, 720);
  assert.equal(combined.entryPriceAusd, null);
  assert.equal(combinedMarketHolding([leader, { ...second, side: 'short' }], 'BTC', 'perpl'), undefined);
  assert.equal(combinedMarketHolding([leader, { ...second, pnlAusd: null }], 'BTC', 'perpl')?.pnlAusd, null);
});

test('partial close rounding to zero cannot become an omitted full-close size', async () => {
  assert.throws(() => positionCloseSizeRaw({ ...leader, sizeRaw: '1' }, 0.25), /too small/);
  assert.throws(() => positionCloseBody('BTC', '0', leader.markerId), /too small/);
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected network request'); };
  try { await assert.rejects(closePosition('offline-token', 'BTC', '0', leader.markerId), /too small/); }
  finally { globalThis.fetch = original; }
  assert.equal(requests, 0);
});

test('partial closes retain precise raw units and reject invalid shares', () => {
  assert.equal(positionCloseSizeRaw({ ...leader, sizeRaw: '1000000000000000001' }, 0.5), '500000000000000000');
  for (const share of [0, -1, 1.1, NaN, Infinity]) assert.throws(() => positionCloseSizeRaw(leader, share), /close amount/);
  assert.throws(() => positionCloseSizeRaw({ ...leader, sizeRaw: '0' }, 1), /remaining size/);
  assert.throws(() => positionCloseBody('BTC', undefined, ''), /lot identifier/);
});

test('result cards use the actual fill ratio even for a requested full or partial close', () => {
  const fill: Fill = { venue: 'perpl', market: 'BTC', side: 'long', sizeRaw: '100', size: 1, priceAusd: 125, notionalAusd: 125, markerId: leader.markerId, tradeId: leader.tradeId };
  const closed = holdingClosedByFill(leader, fill)!;
  assert.equal(closed.size, 1);
  assert.equal(closed.sizeRaw, '100');
  assert.equal(closed.valueAusd, 125);
  assert.equal(closed.pnlAusd, 25);
  assert.equal(closed.markPriceAusd, 125);
  assert.equal(closed.markerId, leader.markerId);
  const card = resultOfClose(closed, fill, { name: 'Trader', avatarUrl: null });
  assert.equal(card.exitPrice, 125);
  assert.equal(card.sizeUsd, 125);
  assert.equal(card.pnlUsd, 25);
  assert.equal(card.investedUsd, 50);
  assert.equal(card.roiPct, 50);
  assert.equal(holdingClosedByFill(leader, { ...fill, sizeRaw: '0', size: 0 }), undefined);
});

test('realized estimates use the filled quantity and closing price for long, short and token lots', () => {
  const fill: Fill = { venue: 'perpl', market: 'BTC', side: 'long', sizeRaw: '125', size: 1.25, priceAusd: 90, notionalAusd: 112.5 };
  const short = holdingClosedByFill({ ...leader, side: 'short', pnlAusd: -200 }, fill)!;
  assert.equal(short.size, fill.size);
  assert.equal(short.pnlAusd, 12.5);
  assert.equal(short.valueAusd, 112.5);
  assert.equal(holdingClosedByFill(leader, fill)?.pnlAusd, -12.5);
  assert.equal(holdingClosedByFill({ ...leader, venue: 'nadfun', side: 'buy' }, { ...fill, venue: 'nadfun', side: 'buy' })?.pnlAusd, -12.5);
  assert.equal(holdingClosedByFill(leader, { ...fill, size: 2, notionalAusd: 180 })?.pnlAusd, -20);
});

test('close cards do not reuse stale mark PnL when entry is unknown or the fill is empty', () => {
  const fill: Fill = { venue: 'perpl', market: 'BTC', side: 'long', sizeRaw: '100', size: 1, priceAusd: 125, notionalAusd: 0 };
  const unknown = holdingClosedByFill({ ...residual, entryPriceAusd: null, pnlAusd: 999 }, fill)!;
  assert.equal(unknown.pnlAusd, null);
  const card = resultOfClose(unknown, fill, { name: 'Trader', avatarUrl: null });
  assert.equal(card.pnlUsd, null);
  assert.equal(card.roiPct, null);
  assert.equal(card.investedUsd, null);
  assert.equal(holdingClosedByFill(leader, fill)?.valueAusd, 125);
  assert.equal(holdingClosedByFill({ ...leader, entryPriceAusd: NaN }, fill)?.entryPriceAusd, null);
  for (const priceAusd of [0, NaN, Infinity]) assert.equal(holdingClosedByFill(leader, { ...fill, priceAusd }), undefined);
  for (const size of [0, -1, NaN, Infinity]) assert.equal(holdingClosedByFill(leader, { ...fill, size }), undefined);
});

test('only leader trade markers can offer chat Copy, never mirror activity notices', () => {
  assert.equal(isLeaderTradeMarker('trade:one'), true);
  for (const marker of ['mirror:copy', 'private:BTC', 'cult:a', 'chart:BTC', 'trade:', '', null, undefined]) assert.equal(isLeaderTradeMarker(marker), false);
});
