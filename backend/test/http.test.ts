import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getJson, UpstreamError } from '../src/http.js';

function serve(handler: (n: number) => { status: number; body?: string; hang?: boolean }) {
  let n = 0;
  const srv = createServer((_req, res) => {
    const r = handler(++n);
    if (r.hang) return; // never respond
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body ?? '{}');
  });
  return new Promise<{ url: string; close: () => void; calls: () => number }>((ok) =>
    srv.listen(0, () => ok({ url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close(), calls: () => n })),
  );
}

test('retries a 503 then succeeds', async () => {
  const s = await serve((n) => (n < 2 ? { status: 503 } : { status: 200, body: '{"ok":1}' }));
  assert.deepEqual(await getJson(s.url), { ok: 1 });
  assert.equal(s.calls(), 2);
  s.close();
});

test('does not retry a 404, fails fast with UpstreamError', async () => {
  const s = await serve(() => ({ status: 404, body: 'nope' }));
  await assert.rejects(getJson(s.url), (e) => e instanceof UpstreamError && /404/.test((e as Error).message));
  assert.equal(s.calls(), 1);
  s.close();
});

test('times out a hung upstream and gives up after the retries', async () => {
  const s = await serve(() => ({ status: 200, hang: true }));
  await assert.rejects(getJson(s.url, { timeoutMs: 200, retries: 1 }), UpstreamError);
  assert.equal(s.calls(), 2);
  s.close();
});
