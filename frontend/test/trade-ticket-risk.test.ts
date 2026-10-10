import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TradeTicket } from '../src/components/TradeTicket';

const renderTicket = (hasPosition: boolean, positionSide?: 'long' | 'short') => renderToStaticMarkup(createElement(TradeTicket, {
  market: { venue: 'perpl', id: 'BTC', symbol: 'BTC-PERP', maxLeverage: 50, priceUsd: 100, takerFeeBps: 5 },
  balances: null, monPriceUsd: null, cults: [], defaultPostTo: 'none', busy: false,
  hasPosition, positionSide, onSubmit: () => { throw new Error('Offline rendering must not submit an order'); },
}));

test('an existing Perpl position has no standalone liquidation price', () => {
  const html = renderTicket(true, 'long');
  assert.match(html, /<dt>Liquidation<\/dt><dd[^>]*>Shared net position<\/dd>/);
  assert.match(html, /leverage and TP\/SL apply to the whole market position/);
  assert.match(html, /Opposite-side trades are blocked; close the existing position first/);
  assert.doesNotMatch(html, /ticket-est/);
});

test('a known opposite-side holding warns before any ticket submission', () => {
  assert.match(renderTicket(true, 'short'), /Close your existing short position before opening a long/);
  assert.doesNotMatch(renderTicket(true, 'long'), /Close your existing long position before opening/);
});

test('a new standalone position retains its labeled liquidation estimate', () => {
  const html = renderTicket(false);
  assert.match(html, /Liquidation/);
  assert.match(html, /ticket-est/);
  assert.doesNotMatch(html, /Shared net position/);
});
