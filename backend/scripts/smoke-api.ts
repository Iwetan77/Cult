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
await call('usdc funding on testnet', 'POST', '/v1/funding/usdc/prepare', auth(bob, 'bob'), { amountUsdc: '25.5' });
await call('open nadfun with perpl side', 'POST', '/v1/positions/open', auth(bob, 'bob'), { marketId: tok, side: 'long', marginUsd: 1 });
await call('skip unknown mirror', 'POST', `/v1/clans/${clan.id}/mirrors/nope/skip`, auth(bob, 'bob'));
await call('indexer accounts (no key)', 'GET', '/v1/indexer/accounts');
await call('indexer accounts', 'GET', '/v1/indexer/accounts', { 'X-Indexer-Key': 'smoke-indexer-key' });
await call('indexer orders', 'GET', '/v1/indexer/orders?since=0', { 'X-Indexer-Key': 'smoke-indexer-key' });
await call('indexer nadfun txs', 'GET', '/v1/indexer/txs?since=0', { 'X-Indexer-Key': 'smoke-indexer-key' });
// Shares: needs an open marker. Seed one leader trade in this throwaway DB only.
const { trades } = await import('../src/mirror/repo.js');
const tokenForShare = tok ?? '0x5e2e014020f31a410cc6cd44defb646b02467777';
const seeded = trades.insert({ id: 'smoke-trade', venue: 'nadfun', userId: 'did:privy:alice', accountId: null, market: tokenForShare, side: 'buy', positionId: null, size: '1000000000000000000', entryPrice: 0.000002, leverage: 100, marginFraction: 0.1, openTx: null, openedAt: Date.now() });
await call('share someone else\'s marker', 'POST', '/v1/shares', auth(bob, 'bob'), { markerId: `trade:${seeded.id}`, includeClan: false });
const sh1 = await call('share own marker, no clan', 'POST', '/v1/shares', auth(alice, 'alice'), { markerId: `trade:${seeded.id}`, includeClan: false });
const pub1 = await call('public share (no clan)', 'GET', `/v1/shares/${sh1.id}`);
const sh2 = await call('share own marker, with clan', 'POST', '/v1/shares', auth(alice, 'alice'), { markerId: `trade:${seeded.id}`, includeClan: true });
const pub2 = await call('public share (with clan)', 'GET', `/v1/shares/${sh2.id}`);
const leaks = ['clanId', 'inviteCode', 'members', 'clan'].filter((k) => k in pub1 || k in pub2);
const txt = JSON.stringify(pub1) + JSON.stringify(pub2);
if (leaks.length || txt.includes(clan.inviteCode) || txt.includes(clan.id)) throw new Error('share leaks clan identity: ' + leaks.join(','));
if ('clanName' in pub1 || pub2.clanName !== 'night shift') throw new Error('clanName opt-in wrong');
console.log('\nshare privacy check OK: no clan id/invite/members in public payloads; clanName only when opted in');
// TP/SL
await call('tpsl on a nad.fun market', 'POST', '/v1/positions/tpsl', auth(alice, 'alice'), { marketId: tokenForShare, takeProfit: 1 });
await call('tpsl without a perpl account', 'POST', '/v1/positions/tpsl', auth(alice, 'alice'), { marketId: '16', takeProfit: 200000 });
await call('suggest tpsl on a nad.fun marker', 'POST', `/v1/clans/${clan.id}/markers/trade:${seeded.id}/suggest-tpsl`, auth(bob, 'bob'), { takeProfit: 1 });
const perplTrade = trades.insert({ id: 'smoke-perpl', venue: 'perpl', userId: 'did:privy:alice', accountId: 999, market: '16', side: 'long', positionId: 1, size: '100', entryPrice: 84000, leverage: 300, marginFraction: 0.1, openTx: null, openedAt: Date.now() });
await call('suggest tpsl, nothing given', 'POST', `/v1/clans/${clan.id}/markers/trade:${perplTrade.id}/suggest-tpsl`, auth(bob, 'bob'), {});
await call('suggest tpsl on a perpl marker', 'POST', `/v1/clans/${clan.id}/markers/trade:${perplTrade.id}/suggest-tpsl`, auth(bob, 'bob'), { takeProfit: 90000, stopLoss: 80000 });
const pc = await call('chart shows the suggestion', 'GET', `/v1/clans/${clan.id}/chart?marketId=16`, auth(alice, 'alice'));
const mk = pc.markers.find((m: any) => m.id === `trade:${perplTrade.id}`);
console.log('perpl marker tp/sl fields:', JSON.stringify({ takeProfitPrice: mk?.takeProfitPrice, stopLossPrice: mk?.stopLossPrice, suggestions: mk?.suggestions }));
if (!mk?.suggestions?.[0] || mk.suggestions[0].takeProfitPrice !== 90000) throw new Error('suggestion missing from chart');
await call('skip with marker-style id', 'POST', `/v1/clans/${clan.id}/mirrors/mirror:does-not-exist/skip`, auth(bob, 'bob'));
await call('skip an unknown pending add', 'POST', `/v1/clans/${clan.id}/mirrors/adjust:does-not-exist/skip`, auth(bob, 'bob'));
// Policy change (signed consent) and leaving.
const newPolicy = { enabled: false, balancePercentCap: 5, maxUsdPerTrade: 20 };
const polCh = await call('policy change challenge', 'POST', `/v1/clans/${clan.id}/policy/challenge`, auth(bob, 'bob'), { policy: newPolicy });
await call('policy change, wrong signer', 'POST', `/v1/clans/${clan.id}/policy`, auth(bob, 'bob'), { challengeId: polCh.challengeId, signature: await alice.signMessage(polCh.message) });
const jc = await call('a join challenge…', 'POST', '/v1/clans/join/challenge', auth(bob, 'bob'), { inviteCode: clan.inviteCode, policy: newPolicy });
await call('…reused as a policy change', 'POST', `/v1/clans/${clan.id}/policy`, auth(bob, 'bob'), { challengeId: jc.challengeId, signature: await bob.signMessage(jc.message) });
const updated = await call('policy change, signed', 'POST', `/v1/clans/${clan.id}/policy`, auth(bob, 'bob'), { challengeId: polCh.challengeId, signature: await bob.signMessage(polCh.message) });
if (JSON.stringify(updated.myPolicy) !== JSON.stringify(newPolicy)) throw new Error('policy not updated');
if (!polCh.message.startsWith('Update my mirror policy')) throw new Error('policy consent text wrong');
await call('leave clan', 'POST', `/v1/clans/${clan.id}/leave`, auth(bob, 'bob'));
await call('chart after leaving', 'GET', `/v1/clans/${clan.id}/chart`, auth(bob, 'bob'));
process.exit(0);
