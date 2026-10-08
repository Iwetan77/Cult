import { createHash } from 'node:crypto';
import webpush, { type PushSubscription } from 'web-push';
import { env } from '../config/env.js';
import { getDb } from '../store/db.js';
import { seal, unseal } from '../store/crypto.js';
import { clans } from '../store/clans.js';
import { tradeCults, type LeaderTrade } from '../mirror/repo.js';
import type { MirrorEngine } from '../mirror/engine.js';
import type { Position } from '../perpl/types.js';
import { nameOf } from '../api/names.js';
import { marketSymbol } from '../api/symbols.js';

export class PushError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const allowedHost = (host: string) => ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com'].includes(host)
  || host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');

// Do not let a subscription turn the sender into an arbitrary HTTP client.
export function validateSubscription(subscription: PushSubscription): void {
  let url: URL;
  try { url = new URL(subscription.endpoint); } catch { throw new PushError(400, 'invalid push endpoint'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHost(url.hostname)) throw new PushError(400, 'unsupported push endpoint');
  const key = subscription.keys?.p256dh ?? '', auth = subscription.keys?.auth ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(key) || !/^[A-Za-z0-9_-]+$/.test(auth) || Buffer.from(key, 'base64url').length !== 65 || Buffer.from(key, 'base64url')[0] !== 4 || Buffer.from(auth, 'base64url').length !== 16) throw new PushError(400, 'invalid push keys');
}

function vapid() {
  const db = getDb();
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'push_vapid'").get() as { value: string } | undefined;
  if (stored) return JSON.parse(Buffer.from(unseal(stored.value)).toString()) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('push_vapid', ?)").run(seal(Buffer.from(JSON.stringify(keys))));
  const saved = db.prepare("SELECT value FROM meta WHERE key = 'push_vapid'").get() as { value: string };
  return JSON.parse(Buffer.from(unseal(saved.value)).toString()) as typeof keys;
}

export const pushPublicKey = () => vapid().publicKey;

export function subscribePush(userId: string, subscription: PushSubscription) {
  validateSubscription(subscription);
  const db = getDb(), id = hash(subscription.endpoint);
  const existing = db.prepare('SELECT user_id FROM push_subscriptions WHERE id = ?').get(id) as { user_id: string } | undefined;
  if (existing && existing.user_id !== userId) throw new PushError(409, 'turn off this device\'s previous notification subscription first');
  const count = db.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number };
  if (!existing && count.n >= 10) throw new PushError(400, 'notification device limit reached');
  db.prepare('INSERT INTO push_subscriptions (id, user_id, subscription, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET subscription = excluded.subscription')
    .run(id, userId, seal(Buffer.from(JSON.stringify(subscription))), Date.now());
}

export function unsubscribePush(userId: string, endpoint: string) {
  getDb().prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(hash(endpoint), userId);
}

export type PushPayload = { title: string; body: string; url: string; tag: string };
type Recipient = { userId: string; clanId?: string };
export function enqueuePush(eventId: string, recipients: Recipient[], payload: PushPayload, now = Date.now()) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const inserted = db.prepare('INSERT OR IGNORE INTO push_events (id, created_at) VALUES (?, ?)').run(eventId, now);
    if (inserted.changes) {
      const queued = new Set<string>();
      for (const recipient of recipients) {
        const subs = db.prepare('SELECT id FROM push_subscriptions WHERE user_id = ?').all(recipient.userId) as { id: string }[];
        for (const sub of subs) {
          if (queued.has(sub.id)) continue;
          queued.add(sub.id);
          db.prepare('INSERT INTO push_deliveries (event_id, subscription_id, clan_id, payload, next_attempt, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(eventId, sub.id, recipient.clanId ?? null, JSON.stringify({ ...payload, url: recipient.clanId ? `/cults/${encodeURIComponent(recipient.clanId)}` : payload.url }), now, now + 3_600_000);
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function tradePushRecipients(trade: LeaderTrade): Recipient[] {
  const recipients: Recipient[] = [];
  for (const clanId of tradeCults(trade, clans.adminCultIds(trade.userId))) {
    for (const member of clans.members(clanId)) if (member.userId !== trade.userId) recipients.push({ userId: member.userId, clanId });
  }
  return recipients;
}

type Send = (subscription: PushSubscription, payload: string) => Promise<unknown>;
const sendPush: Send = (subscription, payload) => {
  const keys = vapid();
  const subject = env.corsOrigins.find(origin => origin.startsWith('https://') && !origin.includes('localhost')) ?? 'https://github.com/Iwetan77/Cult';
  return webpush.sendNotification(subscription, payload, { vapidDetails: { subject, ...keys }, TTL: 3600, urgency: 'high', timeout: 10_000 });
};

export async function flushPush(send: Send = sendPush, now = Date.now()) {
  const db = getDb();
  db.prepare('DELETE FROM push_events WHERE created_at < ?').run(now - 90 * 86_400_000);
  const rows = db.prepare(`SELECT d.*, s.user_id, s.subscription FROM push_deliveries d JOIN push_subscriptions s ON s.id = d.subscription_id
    WHERE d.sent = 0 AND d.next_attempt <= ? ORDER BY d.next_attempt LIMIT 20`).all(now) as unknown as {
      event_id: string; subscription_id: string; clan_id: string | null; payload: string; attempts: number; expires_at: number; user_id: string; subscription: string;
    }[];
  for (const row of rows) {
    if (row.expires_at <= now || row.attempts >= 5 || (row.clan_id && !clans.membership(row.clan_id, row.user_id))) {
      db.prepare('UPDATE push_deliveries SET sent = 1 WHERE event_id = ? AND subscription_id = ?').run(row.event_id, row.subscription_id);
      continue;
    }
    const claimed = db.prepare('UPDATE push_deliveries SET next_attempt = ?, attempts = attempts + 1 WHERE event_id = ? AND subscription_id = ? AND sent = 0 AND next_attempt <= ?')
      .run(now + 60_000, row.event_id, row.subscription_id, now);
    if (!claimed.changes) continue;
    try {
      const subscription = JSON.parse(Buffer.from(unseal(row.subscription)).toString()) as PushSubscription;
      validateSubscription(subscription);
      await send(subscription, row.payload);
      db.prepare('UPDATE push_deliveries SET sent = 1 WHERE event_id = ? AND subscription_id = ?').run(row.event_id, row.subscription_id);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.subscription_id);
      else db.prepare('UPDATE push_deliveries SET next_attempt = ? WHERE event_id = ? AND subscription_id = ?')
        .run(now + Math.min(600_000, 30_000 * 2 ** row.attempts), row.event_id, row.subscription_id);
    }
  }
}

export function startPushNotifications(engine: MirrorEngine) {
  const log = (error: unknown) => console.warn('[push]', error instanceof Error ? error.name : 'delivery error');
  const onTrade = (trade: LeaderTrade) => {
    const recipients = tradePushRecipients(trade);
    if (!recipients.length) return;
    void marketSymbol(trade.venue, trade.market).catch(() => trade.market).then(symbol => {
      const firstCult = recipients[0]!.clanId!;
      const id = `trade:${trade.id}`;
      enqueuePush(id, recipients, { title: `${nameOf(trade.userId)} placed a trade`, body: `${symbol} ${trade.side}`, url: `/cults/${encodeURIComponent(firstCult)}`, tag: id });
    }).catch(log);
  };
  const onLiquidation = (userId: string, position: Position) => {
    void marketSymbol('perpl', String(position.mkt)).catch(() => `Perpl market ${position.mkt}`).then(symbol => {
      const id = `liquidation:${env.chainId}:${position.acc}:${position.pid}`;
      enqueuePush(id, [{ userId }], { title: 'Position liquidated', body: `Your ${symbol} position was liquidated on Perpl.`, url: `/markets/${position.mkt}`, tag: id });
    }).catch(log);
  };
  engine.on('trade', onTrade);
  engine.on('liquidation', onLiquidation);
  let busy = false;
  const tick = () => { if (busy) return; busy = true; void flushPush().catch(log).finally(() => { busy = false; }); };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return () => { clearInterval(timer); engine.off('trade', onTrade); engine.off('liquidation', onLiquidation); };
}
