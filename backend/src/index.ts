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

getDb();
if (storageStatus().persistent === false) {
  console.error(`[db] ${env.dbPath} is NOT on a Railway volume: every member, cult and chat is wiped on each deploy. Attach a volume at /data.`);
}
const engine = new MirrorEngine({ optOutSeconds: env.mirrorOptOutSeconds }, { sessionFor });
startActivityFeed(engine);
await engine.start();
void reconcileStacks().catch((e) => console.error('[stack] reconcile', e));
const stopUsdc = startUsdcConversion();
warmMarkets();

const server = serve({ fetch: createApp(engine).fetch, port: env.port }, (info) => {
  console.log(`cult backend on :${info.port} (perpl ${env.perplApiUrl}, chain ${env.chainId}, opt-out ${env.mirrorOptOutSeconds}s)`);
});

const shutdown = () => {
  engine.stop();
  stopUsdc();
  stopAllSessions();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
