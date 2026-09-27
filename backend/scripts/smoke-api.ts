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
// Cults: ABC-DEF codes (typed any way), /v1/cults paths, public cults.
if (!/^[A-Z]{3}-[A-Z]{3}$/.test(clan.inviteCode)) throw new Error(`invite code ${clan.inviteCode} is not ABC-DEF`);
const dave = ethers.Wallet.createRandom();
const typed = clan.inviteCode.replace('-', '').toLowerCase();
const dch = await call('join with the code typed lowercase, no dash', 'POST', '/v1/cults/join/challenge', auth(dave, 'dave'), { inviteCode: typed, policy });
if (!dch.message?.startsWith('Join the Cult')) throw new Error('consent text wrong');
await call('private cult by id is refused', 'POST', '/v1/cults/join/challenge', auth(dave, 'dave'), { cultId: clan.id, policy });
await call('already a member', 'POST', '/v1/cults/join/challenge', auth(bob, 'bob'), { inviteCode: clan.inviteCode, policy });
const openCult = await call('create a public cult', 'POST', '/v1/cults', auth(alice, 'alice'), { name: 'open floor', policy, visibility: 'public' });
const disc = await call('discover public cults', 'GET', '/v1/cults/discover', auth(dave, 'dave'));
if (!disc.cults.some((x: any) => x.id === openCult.id) || disc.cults.some((x: any) => x.id === clan.id)) throw new Error('discover lists the wrong cults');
const och = await call('join a public cult by id', 'POST', '/v1/cults/join/challenge', auth(dave, 'dave'), { cultId: openCult.id, policy });
await call('join it', 'POST', '/v1/cults/join', auth(dave, 'dave'), { challengeId: och.challengeId, signature: await dave.signMessage(och.message) });
await call('only the owner changes visibility', 'POST', `/v1/cults/${openCult.id}/visibility`, auth(dave, 'dave'), { visibility: 'private' });
await call('old /v1/clans paths still work', 'GET', `/v1/clans/${clan.id}/messages`, auth(bob, 'bob'));
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
// Clan chat.
const hi = await call('chat: alice posts', 'POST', `/v1/clans/${clan.id}/messages`, auth(alice, 'alice'), { body: 'selling half of my BTC in 5 min', markerId: 'trade:smoke-perpl' });
await call('chat: bob replies', 'POST', `/v1/clans/${clan.id}/messages`, auth(bob, 'bob'), { body: 'ok, I will ride it', replyTo: hi.id });
await call('chat: empty', 'POST', `/v1/clans/${clan.id}/messages`, auth(bob, 'bob'), { body: '   ' });
await call('chat: outsider', 'POST', `/v1/clans/${clan.id}/messages`, auth(ethers.Wallet.createRandom(), 'eve'), { body: 'hi' });
const page = await call('chat: list', 'GET', `/v1/clans/${clan.id}/messages?limit=1`, auth(bob, 'bob'));
if (page.messages.length !== 1 || !page.hasMore || page.messages[0].replyTo !== hi.id) throw new Error('chat page wrong');
const older = await call('chat: older page', 'GET', `/v1/clans/${clan.id}/messages?before=${page.messages[0].id}`, auth(bob, 'bob'));
if (older.messages[0]?.id !== hi.id || older.hasMore) throw new Error('chat paging wrong');
// Global and country rooms.
await call('not a country', 'POST', '/v1/me/country', auth(alice, 'alice'), { country: 'EU' });
const ctry = await call('pick a country', 'POST', '/v1/me/country', auth(alice, 'alice'), { country: 'ng' });
if (ctry.country?.name !== 'Nigeria' || !ctry.rooms.some((r: any) => r.id === 'country:NG')) throw new Error('country room missing');
const rooms = await call('my rooms', 'GET', '/v1/chat/rooms', auth(alice, 'alice'));
if (rooms.rooms[0]?.id !== 'global') throw new Error('global room missing');
await call('post in global', 'POST', '/v1/chat/global/messages', auth(alice, 'alice'), { body: 'gm from Lagos' });
const g = await call('read global (anyone signed in)', 'GET', '/v1/chat/global/messages', auth(bob, 'bob'));
if (!g.messages.some((m: any) => m.body === 'gm from Lagos' && m.room === 'global')) throw new Error('global message missing');
await call('post in my country room', 'POST', '/v1/chat/country:NG/messages', auth(alice, 'alice'), { body: 'naija traders' });
await call("someone else's country room", 'GET', '/v1/chat/country:NG/messages', auth(bob, 'bob'));
await call('a cult room via /chat', 'GET', `/v1/chat/cult:${clan.id}/messages`, auth(bob, 'bob'));
const me2 = await call('me shows country and rooms', 'GET', '/v1/me', auth(alice, 'alice'));
if (me2.country?.code !== 'NG' || me2.rooms.length < 3) throw new Error('me is missing country/rooms');
// Leaderboards (no indexer in the smoke run, so everyone is unranked; shapes and access only).
const gb = await call('global leaderboard', 'GET', '/v1/leaderboards/global', auth(alice, 'alice'));
if (gb.scope !== 'global' || !Array.isArray(gb.entries) || gb.me?.rank !== null) throw new Error('global board shape');
await call('my country board', 'GET', '/v1/leaderboards/country', auth(alice, 'alice'));
await call('country board before picking one', 'GET', '/v1/leaderboards/country', auth(bob, 'bob'));
await call('another country board', 'GET', '/v1/leaderboards/country/GB', auth(bob, 'bob'));
const cb = await call('public cults ranked', 'GET', '/v1/leaderboards/cults', auth(bob, 'bob'));
if (!cb.entries.some((e: any) => e.cultId === openCult.id) || cb.entries.some((e: any) => e.cultId === clan.id)) throw new Error('cults board lists the wrong cults');
await call('my cult board', 'GET', `/v1/cults/${clan.id}/leaderboard`, auth(bob, 'bob'));
await call("a private cult's board, as an outsider", 'GET', `/v1/cults/${clan.id}/leaderboard`, auth(ethers.Wallet.createRandom(), 'eve'));
await call("a public cult's board, as an outsider", 'GET', `/v1/cults/${openCult.id}/leaderboard`, auth(ethers.Wallet.createRandom(), 'eve2'));
// Policy change (signed consent) and leaving.
const newPolicy = { enabled: false, balancePercentCap: 5, maxUsdPerTrade: 20 };
const polCh = await call('policy change challenge', 'POST', `/v1/clans/${clan.id}/policy/challenge`, auth(bob, 'bob'), { policy: newPolicy });
await call('policy change, wrong signer', 'POST', `/v1/clans/${clan.id}/policy`, auth(bob, 'bob'), { challengeId: polCh.challengeId, signature: await alice.signMessage(polCh.message) });
const jc = await call('a join challenge…', 'POST', '/v1/cults/join/challenge', auth(bob, 'bob'), { cultId: openCult.id, policy: newPolicy });
await call('…reused as a policy change', 'POST', `/v1/clans/${clan.id}/policy`, auth(bob, 'bob'), { challengeId: jc.challengeId, signature: await bob.signMessage(jc.message) });
const updated = await call('policy change, signed', 'POST', `/v1/clans/${clan.id}/policy`, auth(bob, 'bob'), { challengeId: polCh.challengeId, signature: await bob.signMessage(polCh.message) });
if (JSON.stringify(updated.myPolicy) !== JSON.stringify(newPolicy)) throw new Error('policy not updated');
if (!polCh.message.startsWith('Update my copy limits in the Cult')) throw new Error('policy consent text wrong');
await call('leave clan', 'POST', `/v1/clans/${clan.id}/leave`, auth(bob, 'bob'));
await call('chart after leaving', 'GET', `/v1/clans/${clan.id}/chart`, auth(bob, 'bob'));
// Rate limits: a burst of order calls from one member is cut off with Retry-After.
const carol = ethers.Wallet.createRandom();
let limitedRes: Response | undefined;
for (let i = 0; i < 30 && !limitedRes; i++) {
  const r = await app.request('/v1/positions/close', { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(carol, 'carol') }, body: '{}' });
  if (r.status === 429) limitedRes = r;
}
if (!limitedRes?.headers.get('Retry-After')) throw new Error('order burst was not rate limited');
console.log(`\n### order burst\n-> 429 after the per-minute trade limit, Retry-After ${limitedRes.headers.get('Retry-After')}s: ${await limitedRes.text()}`);
process.exit(0);
