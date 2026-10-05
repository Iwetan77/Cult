'use client';

import { useSyncExternalStore } from 'react';

// Per-account conveniences kept on this device: starred markets, price
// alerts, the alerts feed and the chart style. None of it is on the backend,
// so it never leaves the browser; storage that's blocked just means it
// starts empty. Every write notifies every reader on the page.

export type PriceAlert = { id: string; marketId: string; symbol: string; direction: 'above' | 'below'; price: number; createdAt: number };
export type AlertItem = {
  id: string; kind: 'price' | 'cult'; title: string; body: string; at: number; read: boolean;
  marketId?: string; roomId?: string;
};

const EVENT = 'cult:prefs';
const FEED_MAX = 40;

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw) as T;
  } catch { return fallback; }
};
const write = (key: string, value: unknown) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* the page still updates for this visit */ }
  memory.set(key, value);
  window.dispatchEvent(new Event(EVENT));
};

// Snapshots must be stable between writes for useSyncExternalStore.
const memory = new Map<string, unknown>();
const snapshot = <T,>(key: string, fallback: T): T => {
  if (!memory.has(key)) memory.set(key, read(key, fallback));
  return memory.get(key) as T;
};
const subscribe = (onChange: () => void) => {
  const onStorage = (event: StorageEvent) => { if (event.key) { memory.delete(event.key); onChange(); } };
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener('storage', onStorage); };
};
const useKey = <T,>(key: string, fallback: T): T =>
  useSyncExternalStore(subscribe, () => snapshot(key, fallback), () => fallback);

const EMPTY: never[] = [];
const keys = (owner: string) => ({ starred: `cult:starred:${owner}`, alerts: `cult:price-alerts:${owner}`, feed: `cult:alert-feed:${owner}` });

// Starred markets, newest first.
export const useStarred = (owner: string) => useKey<string[]>(keys(owner).starred, EMPTY);
export const toggleStar = (owner: string, marketId: string) => {
  const key = keys(owner).starred;
  const list = snapshot<string[]>(key, EMPTY);
  write(key, list.includes(marketId) ? list.filter(id => id !== marketId) : [marketId, ...list]);
};

// Price alerts: each fires once, then it's gone.
export const usePriceAlerts = (owner: string) => useKey<PriceAlert[]>(keys(owner).alerts, EMPTY);
export const priceAlerts = (owner: string) => snapshot<PriceAlert[]>(keys(owner).alerts, EMPTY);
export const addPriceAlert = (owner: string, alert: Omit<PriceAlert, 'id' | 'createdAt'>) => {
  const key = keys(owner).alerts;
  write(key, [...snapshot<PriceAlert[]>(key, EMPTY), { ...alert, id: `pa-${Date.now().toString(36)}`, createdAt: Date.now() }]);
};
export const removePriceAlert = (owner: string, id: string) => {
  const key = keys(owner).alerts;
  write(key, snapshot<PriceAlert[]>(key, EMPTY).filter(a => a.id !== id));
};

// The alerts feed shown under the bell.
export const useAlertFeed = (owner: string) => useKey<AlertItem[]>(keys(owner).feed, EMPTY);
export const pushAlert = (owner: string, item: Omit<AlertItem, 'id' | 'at' | 'read'>) => {
  const key = keys(owner).feed;
  write(key, [{ ...item, id: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), read: false }, ...snapshot<AlertItem[]>(key, EMPTY)].slice(0, FEED_MAX));
};
export const markAlertsRead = (owner: string) => {
  const key = keys(owner).feed;
  const list = snapshot<AlertItem[]>(key, EMPTY);
  if (list.some(a => !a.read)) write(key, list.map(a => ({ ...a, read: true })));
};
export const clearAlerts = (owner: string) => write(keys(owner).feed, []);

// Candles or Line, the same on every market.
export type StoredChartStyle = 'candles' | 'line';
export const useChartStylePref = () => useKey<StoredChartStyle>('cult:chart-style', 'candles');
export const setChartStylePref = (style: StoredChartStyle) => write('cult:chart-style', style);
