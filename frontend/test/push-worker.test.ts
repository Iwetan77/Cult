import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function worker() {
  type WorkerEvent = { data?: { json: () => unknown }; notification?: { close: () => void; data: { url: string } }; waitUntil: (promise: Promise<unknown>) => void };
  type Notification = { title: string; body?: string; tag?: string; data: { url: string } };
  const handlers: Record<string, (event: WorkerEvent) => void> = {};
  const notifications: Notification[] = [], opened: string[] = [];
  const self = { location: { origin: 'https://cult.example' }, addEventListener: (type: string, handler: (event: WorkerEvent) => void) => { handlers[type] = handler; },
    registration: { showNotification: async (title: string, options: Omit<Notification, 'title'>) => { notifications.push({ title, ...options }); } },
    clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } },
  };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, URL });
  return { handlers, notifications, opened };
}
test('push displays a user-visible notification with its trade destination', async () => {
  const w = worker(); let work: Promise<unknown> | undefined;
  w.handlers.push!({ data: { json: () => ({ title: 'Position liquidated', body: 'MON-PERP', url: '/markets/16', tag: 'liq:123' }) }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work;
  assert.equal(w.notifications[0].title, 'Position liquidated');
  assert.equal(w.notifications[0].data.url, '/markets/16');
  assert.equal(w.notifications[0].tag, 'liq:123');
});
test('notification clicks never open another origin', async () => {
  const w = worker(); let work: Promise<unknown> | undefined;
  w.handlers.notificationclick!({ notification: { close() {}, data: { url: 'https://attacker.example' } }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work;
  assert.equal(w.opened[0], 'https://cult.example/');
});
test('notification clicks open the relevant cult', async () => {
  const w = worker(); let work: Promise<unknown> | undefined;
  w.handlers.notificationclick!({ notification: { close() {}, data: { url: '/cults/abc' } }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work;
  assert.equal(w.opened[0], 'https://cult.example/cults/abc');
});
