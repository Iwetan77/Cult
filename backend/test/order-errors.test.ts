import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);
process.env.LOG_REQUESTS = '0';

test('structured transaction fee failures prompt a MON top-up instead of an internal error', async () => {
  const { createApp } = await import('../src/api/server.js');
  const engine = new EventEmitter() as import('../src/mirror/engine.js').MirrorEngine;
  const app = createApp(engine);
  app.get('/test/gas', () => {
    throw Object.assign(new Error('transaction cannot be paid'), { code: 'INSUFFICIENT_FUNDS' });
  });
  const response = await app.request('/test/gas');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { message: 'Top up MON for gas.', code: 'needs_gas' });
});

test('Perpl rejections retain their reason instead of becoming an internal error', async () => {
  const { createApp } = await import('../src/api/server.js');
  const { OrderFailed } = await import('../src/trading/positions.js');
  const engine = new EventEmitter() as import('../src/mirror/engine.js').MirrorEngine;
  const app = createApp(engine);
  app.get('/test/order', () => {
    throw new OrderFailed({ st: 9, sr: 12, fr: 3, rq: 41, fs: 0 } as import('../src/perpl/types.js').Order);
  });
  const response = await app.request('/test/order');
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.code, 'order_failed');
  assert.match(body.message, /status 9, reason 12, fill reason 3/);
  assert.match(body.message, /Refresh your positions/);
});

test('an incomplete order is not reported as unsubmitted or automatically retried', async () => {
  const { createApp } = await import('../src/api/server.js');
  const { OrderFailed } = await import('../src/trading/positions.js');
  const engine = new EventEmitter() as import('../src/mirror/engine.js').MirrorEngine;
  const app = createApp(engine);
  let calls = 0;
  app.get('/test/order', () => {
    calls++;
    throw new OrderFailed({ st: 9, sr: 12, rq: 42, fs: 10 } as import('../src/perpl/types.js').Order);
  });
  const response = await app.request('/test/order');
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.doesNotMatch(body.message, /No order was sent|not filled|retry shortly/i);
  assert.equal(calls, 1);
});
