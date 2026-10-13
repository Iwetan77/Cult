import { serve } from '@hono/node-server';
import { sessionFor, stopAllSessions } from './accounts/lifecycle.js';
import { startActivityFeed } from './api/activity.js';
import { createApp, storageStatus } from './api/server.js';
import { env } from './config/env.js';
import { MirrorEngine } from './mirror/engine.js';
import { reconcileStacks } from './mirror/stack.js';
import { startUsdcConversion } from './funding/usdc.js';
import { warmMarkets } from './api/markets.js';
import { getDb } from './store/db.js';
import { startPushNotifications } from './notifications/push.js';

// A stray failure in one background task (a dropped socket, an RPC blip
// during a post-restart reconcile) must not take every member's copies and
// the whole API down with it. Rejections are logged and the process keeps
// running; uncaught exceptions too, unless they come in a burst, which means
// something is really broken and Railway should restart us.
process.on('unhandledRejection', (reason) => console.error('[process] unhandled rejection (kept running):', reason));
let exceptions: number[] = [];
process.on('uncaughtException', (e) => {
  console.error('[process] uncaught exception:', e);
  const now = Date.now();
  exceptions = [...exceptions.filter((t) => now - t < 60_000), now];
  if (exceptions.length >= 5) {
    console.error('[process] 5 uncaught exceptions in a minute; exiting so the host restarts us');
    process.exit(1);
  }
});

getDb();
if (storageStatus().persistent === false) {
  console.error(`[db] ${env.dbPath} is NOT on a Railway volume: every member, cult and chat is wiped on each deploy. Attach a volume at /data.`);
}
const engine = new MirrorEngine({ optOutSeconds: env.mirrorOptOutSeconds }, { sessionFor });
startActivityFeed(engine);
const stopPush = startPushNotifications(engine);

// The API comes up first, so the health check passes and members can use the
// app while the engine connects to Perpl and the chain.
const server = serve({ fetch: createApp(engine).fetch, port: env.port }, (info) => {
  console.log(`cult backend on :${info.port} (perpl ${env.perplApiUrl}, chain ${env.chainId}, opt-out ${env.mirrorOptOutSeconds}s)`);
});

// The engine needs Perpl and the RPC to start. If either is briefly away
// (right after a deploy is when it happens), retry instead of crashing.
let stopped = false;
async function startEngine() {
  for (let attempt = 1; !stopped; attempt++) {
    try {
      await engine.start();
      if (attempt > 1) console.log(`[mirror] engine started on attempt ${attempt}`);
      return;
    } catch (e) {
      const waitMs = Math.min(60_000, 5_000 * attempt);
      console.error(`[mirror] engine start failed (attempt ${attempt}), retrying in ${waitMs / 1000}s:`, e);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
void startEngine();
void reconcileStacks().catch((e) => console.error('[stack] reconcile', e));
const stopUsdc = startUsdcConversion();
warmMarkets();

const shutdown = () => {
  stopped = true;
  engine.stop();
  stopPush();
  stopUsdc();
  stopAllSessions();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
