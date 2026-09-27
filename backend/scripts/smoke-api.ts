// Boots the API against a throwaway DB with dev auth and exercises every route
// that doesn't need a funded wallet. Prints real request/response pairs.
import { ethers } from 'ethers';
process.env.DEV_AUTH = '1';
process.env.DB_PATH = process.env.DB_PATH ?? `data/smoke-${Date.now()}.db`;
process.env.INDEXER_API_KEY = 'smoke-indexer-key';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

const { sessionFor } = await import('../src/accounts/lifecycle.js');
const { createApp } = await import('../src/api/server.js');
const { MirrorEngine } = await import('../src/mirror/engine.js');

const app = createApp(new MirrorEngine({ optOutSeconds: 20 }, { sessionFor, nadWatcher: null }));
const alice = ethers.Wallet.createRandom();
const bob = ethers.Wallet.createRandom();
const auth = (w: ethers.HDNodeWallet, id: string) => ({ Authorization: `Dev did:privy:${id} ${w.address}` });

async function call(label: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch {}
  console.log(`\n### ${label}\n${method} ${path}${body ? '\n' + JSON.stringify(body) : ''}\n-> ${res.status}\n${JSON.stringify(json, null, 2)?.slice(0, 1800)}`);
  if (res.status >= 500) throw new Error(`${label} 5xx`);
  return json as any;
}

await call('health', 'GET', '/v1/health');
const cfg = await call('config', 'GET', '/v1/config');
await call('me (no auth)', 'GET', '/v1/me');
await call('me', 'GET', '/v1/me', auth(alice, 'alice'));
const policy = { enabled: true, balancePercentCap: 25, maxUsdPerTrade: 200 };
const clan = await call('create clan', 'POST', '/v1/clans', auth(alice, 'alice'), { name: 'night shift', policy });
await call('bad policy', 'POST', '/v1/clans', auth(alice, 'alice'), { name: 'x', policy: { enabled: true, balancePercentCap: 150, maxUsdPerTrade: 0 } });
const ch = await call('join challenge', 'POST', '/v1/clans/join/challenge', auth(bob, 'bob'), { inviteCode: clan.inviteCode, policy: { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 50 } });
await call('join with wrong signer', 'POST', '/v1/clans/join', auth(bob, 'bob'), { challengeId: ch.challengeId, signature: await alice.signMessage(ch.message) });
await call('join', 'POST', '/v1/clans/join', auth(bob, 'bob'), { challengeId: ch.challengeId, signature: await bob.signMessage(ch.message) });
const btc = cfg.markets.find((m: any) => m.baseSymbol === 'BTC');
const chart = await call('chart', 'GET', `/v1/clans/${clan.id}/chart?marketId=${btc.id}&resolution=60`, auth(bob, 'bob'));
console.log('candles:', chart.candles.length, 'first', chart.candles[0], 'markers', chart.markers.length);
await call('chart (outsider)', 'GET', `/v1/clans/${clan.id}/chart`, auth(ethers.Wallet.createRandom(), 'eve'));
await call('perpl setup', 'GET', '/v1/perpl/setup', auth(bob, 'bob'));
const nad = await call('nadfun markets', 'GET', '/v1/nadfun/markets?order=latest_trade');
const tok = nad.markets[0]?.id;
if (tok) {
  const nchart = await call('chart (nadfun token)', 'GET', `/v1/clans/${clan.id}/chart?marketId=${tok}&resolution=60`, auth(bob, 'bob'));
  console.log('nadfun candles:', nchart.candles.length, 'first', JSON.stringify(nchart.candles[0]), 'selected', JSON.stringify(nchart.selectedMarket));
}
await call('positions (both venues)', 'GET', '/v1/positions', auth(bob, 'bob'));
await call('open nadfun with perpl side', 'POST', '/v1/positions/open', auth(bob, 'bob'), { marketId: tok, side: 'long', marginUsd: 1 });
await call('skip unknown mirror', 'POST', `/v1/clans/${clan.id}/mirrors/nope/skip`, auth(bob, 'bob'));
await call('indexer accounts (no key)', 'GET', '/v1/indexer/accounts');
await call('indexer accounts', 'GET', '/v1/indexer/accounts', { 'X-Indexer-Key': 'smoke-indexer-key' });
await call('indexer orders', 'GET', '/v1/indexer/orders?since=0', { 'X-Indexer-Key': 'smoke-indexer-key' });
await call('indexer nadfun txs', 'GET', '/v1/indexer/txs?since=0', { 'X-Indexer-Key': 'smoke-indexer-key' });
process.exit(0);
