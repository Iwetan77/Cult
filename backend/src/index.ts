import { serve } from '@hono/node-server';
import { sessionFor, stopAllSessions } from './accounts/lifecycle.js';
import { createApp } from './api/server.js';
import { env } from './config/env.js';
import { MirrorEngine } from './mirror/engine.js';
import { getDb } from './store/db.js';

getDb();
const engine = new MirrorEngine({ optOutSeconds: env.mirrorOptOutSeconds }, { sessionFor });
await engine.start();

const server = serve({ fetch: createApp(engine).fetch, port: env.port }, (info) => {
  console.log(`cult backend on :${info.port} (perpl ${env.perplApiUrl}, chain ${env.chainId}, opt-out ${env.mirrorOptOutSeconds}s)`);
});

const shutdown = () => {
  engine.stop();
  stopAllSessions();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
