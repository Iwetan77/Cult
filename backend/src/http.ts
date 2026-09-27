// Read-only upstream calls (Perpl market data, Nad.fun lists/charts): bounded
// by a timeout and retried with backoff on network errors, 429 and 5xx, so a
// flaky upstream costs a retry, not a hung request.

export class UpstreamError extends Error {
  constructor(
    readonly url: string,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<T>(url: string, opts: { timeoutMs?: number; retries?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return (await r.json()) as T;
      if (r.status !== 429 && r.status < 500) throw new UpstreamError(url, `${r.status} ${(await r.text()).slice(0, 200)}`);
      last = new UpstreamError(url, `HTTP ${r.status}`);
    } catch (e) {
      if (e instanceof UpstreamError && !/HTTP (429|5\d\d)/.test(e.message)) throw e;
      last = e;
    }
    if (attempt < retries) await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
  throw new UpstreamError(url, `unreachable after ${retries + 1} tries: ${String((last as Error)?.message ?? last)}`);
}
