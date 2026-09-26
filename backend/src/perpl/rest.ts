import { env } from '../config/env.js';
import { signRestHeaders, type ApiKeyCredentials } from './auth.js';
import type { Fill, HistoryPage, Order, OrderSpec, Position, Snapshot, Status, Wallet } from './types.js';

export class PerplHttpError extends Error {
  constructor(
    readonly status: number,
    readonly target: string,
    body: string,
  ) {
    super(`perpl ${target} -> ${status} ${body.slice(0, 300)}`);
  }
}

// Signed REST client for one API key (i.e. one member's wallet). Reads are the
// source of truth for tests and reconciliation; order placement normally goes
// over the member's TradingSession, with REST batch as the connectionless path.
export class PerplRest {
  constructor(private readonly creds: ApiKeyCredentials) {}

  private async call<T>(method: 'GET' | 'POST', target: string, body = '', attempt = 0): Promise<T> {
    const headers = await signRestHeaders(this.creds, method, target, body);
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${env.perplApiUrl}${target}`, { method, headers, ...(body ? { body } : {}) });
    // 429 = edge rate limit, 503 = gateway still catching up with the chain. Both retryable.
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return this.call<T>(method, target, body, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new PerplHttpError(res.status, target, text);
    return JSON.parse(text) as T;
  }

  wallet() {
    return this.call<Wallet & { sts?: unknown[] }>('GET', '/v1/trading/wallet');
  }
  positions() {
    return this.call<Snapshot<Position>>('GET', '/v1/trading/positions');
  }
  openOrders() {
    return this.call<Snapshot<Order>>('GET', '/v1/trading/orders');
  }
  fills(count = 50) {
    return this.call<HistoryPage<Fill>>('GET', `/v1/trading/fills?count=${count}`);
  }
  orderHistory(count = 50) {
    return this.call<HistoryPage<Order>>('GET', `/v1/trading/order-history?count=${count}`);
  }
  positionHistory(count = 50) {
    return this.call<HistoryPage<Position>>('GET', `/v1/trading/position-history?count=${count}`);
  }
  accountHistory(count = 50) {
    return this.call<HistoryPage<unknown>>('GET', `/v1/trading/account-history?count=${count}`);
  }

  // Per-order statuses, positionally matched to `orders`. Code 0 = accepted for
  // forwarding only; the outcome lands on order history / mt:24 a block later.
  async submitOrders(orders: OrderSpec[]): Promise<Status[]> {
    const reply = await this.call<{ status: Status; statuses?: Status[] }>(
      'POST',
      '/v1/trading/orders',
      JSON.stringify({ d: orders }),
    );
    if (reply.status?.code) throw new Error(`perpl batch refused: ${reply.status.code} ${reply.status.error}`);
    return reply.statuses ?? [];
  }
}
