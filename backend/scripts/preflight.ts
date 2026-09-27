// Run before starting the backend on a new host, or before switching network
// (testnet -> mainnet): checks every setting and outside service the backend
// depends on is really there and agrees with each other. Read-only.
//   npm run preflight            exit 1 on any FAIL
import '../src/config/env.js';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../src/config/env.js';
import { rpc } from '../src/chain/signer.js';
import { NADFUN } from '../src/nadfun/constants.js';
import { getContext, getExchangeInfo } from '../src/perpl/context.js';
import { monPriceAusd } from '../src/prices.js';
import { KURU_FLOW_ROUTER } from '../src/swap/kuruFlow.js';
import { nadPaysWith } from '../src/venues/nadfun.js';

type Level = 'OK' | 'WARN' | 'FAIL';
const results: { level: Level; what: string; detail: string }[] = [];
const say = (level: Level, what: string, detail = '') => {
  results.push({ level, what, detail });
  console.log(`${level.padEnd(4)} ${what}${detail ? ` - ${detail}` : ''}`);
};
// A check that throws (network blip) gets one more try before it counts as FAIL.
async function check(what: string, fn: () => Promise<[Level, string] | Level>) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fn();
      const [level, detail] = Array.isArray(r) ? r : [r, ''];
      return say(level, what, detail);
    } catch (e) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return say('FAIL', what, String((e as Error)?.message ?? e).slice(0, 200));
    }
  }
}
const hasCode = async (addr: string) => (await rpc().getCode(addr)) !== '0x';
const mainnet = env.chainId === 143;
const privyHeaders = () => {
  const appId = process.env.PRIVY_APP_ID ?? '';
  return { Authorization: 'Basic ' + Buffer.from(`${appId}:${process.env.PRIVY_APP_SECRET ?? ''}`).toString('base64'), 'privy-app-id': appId };
};

console.log(`preflight for chain ${env.chainId} (${mainnet ? 'MAINNET' : 'testnet'})\n`);

// ---- chain -------------------------------------------------------------------
await check('RPC answers on the configured chain', async () => {
  const id = Number((await rpc().getNetwork()).chainId);
  if (id !== env.chainId) return ['FAIL', `RPC is chain ${id}, PERPL_CHAIN_ID is ${env.chainId}`];
  return process.env.ALCHEMY_MONAD_RPC_URL ? 'OK' : ['WARN', 'public Monad RPC (rate limited); set ALCHEMY_MONAD_RPC_URL'];
});

// ---- Perpl ---------------------------------------------------------------------
await check('Perpl API matches the network', async () => {
  const testnetUrl = /testnet/i.test(env.perplApiUrl) || /testnet/i.test(env.perplWsUrl);
  if (mainnet && testnetUrl) return ['FAIL', `chain 143 but Perpl URLs point at testnet (${env.perplApiUrl})`];
  if (!mainnet && !testnetUrl) return ['WARN', `testnet chain but Perpl URLs don't say testnet (${env.perplApiUrl})`];
  return 'OK';
});
await check('Perpl context: exchange and collateral exist on this chain', async () => {
  const ctx = await getContext();
  const x = await getExchangeInfo();
  if (!(await hasCode(x.exchange))) return ['FAIL', `no contract at exchange ${x.exchange}`];
  if (!(await hasCode(x.collateralToken))) return ['FAIL', `no contract at collateral ${x.collateralToken}`];
  const open = ctx.markets.filter((m) => m.config.is_open).length;
  return ['OK', `exchange ${x.exchange}, collateral ${x.collateralToken} (${x.collateralDecimals} dp), ${open} open markets`];
});
await check('MON price available (values memes in $)', async () => {
  const px = await monPriceAusd();
  return px > 0 ? ['OK', `$${px}`] : ['FAIL', 'no MON mark on Perpl'];
});
await check('Perpl origin header', async () =>
  mainnet && !env.perplOrigin ? ['WARN', 'PERPL_ORIGIN unset; mainnet may require a whitelisted origin'] : 'OK',
);

// ---- Nad.fun / Kuru -------------------------------------------------------------
await check('Nad.fun router deployed on this chain', async () =>
  (await hasCode(NADFUN.router)) ? ['OK', NADFUN.router] : ['FAIL', `no contract at ${NADFUN.router}`],
);
await check('Nad.fun API reachable', async () => {
  const r = await fetch(`${NADFUN.apiUrl}/order/latest_trade?page=1&limit=1`, { signal: AbortSignal.timeout(10_000) });
  return r.ok ? ['OK', NADFUN.apiUrl] : ['WARN', `${NADFUN.apiUrl} -> ${r.status} (market lists; trading works without it)`];
});
await check('Memes pay-with setting fits the chain', async () => {
  const pay = nadPaysWith();
  if (pay === 'ausd' && !(await hasCode(KURU_FLOW_ROUTER))) return ['FAIL', `NADFUN_PAY_WITH=ausd but Kuru Flow isn't on chain ${env.chainId}`];
  if (mainnet && pay === 'mon') return ['WARN', 'mainnet with NADFUN_PAY_WITH=mon: members pay memes in MON, not $'];
  return ['OK', pay];
});

// ---- Privy ----------------------------------------------------------------------
await check('Privy app credentials', async () => {
  for (const k of ['PRIVY_APP_ID', 'PRIVY_APP_SECRET']) if (!process.env[k]) return ['FAIL', `${k} unset`];
  const r = await fetch(`https://auth.privy.io/api/v1/apps/${process.env.PRIVY_APP_ID}/jwks.json`, { signal: AbortSignal.timeout(10_000) });
  return r.ok ? 'OK' : ['FAIL', `JWKS for ${process.env.PRIVY_APP_ID} -> ${r.status}`];
});
await check("backend signer: our key is the one registered on Privy's key quorum", async () => {
  const id = process.env.PRIVY_BACKEND_KEY_QUORUM_ID;
  const key = process.env.PRIVY_BACKEND_AUTH_KEY;
  if (!id || !key) return ['FAIL', 'PRIVY_BACKEND_KEY_QUORUM_ID / PRIVY_BACKEND_AUTH_KEY unset'];
  const r = await fetch(`https://api.privy.io/v1/key_quorums/${encodeURIComponent(id)}`, { headers: privyHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return ['FAIL', `key quorum ${id} -> ${r.status}`];
  const q = (await r.json()) as { authorization_keys?: { public_key: string }[] };
  const der = Buffer.from(key.replace(/^wallet-auth:/, ''), 'base64');
  const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).toString('base64');
  return q.authorization_keys?.some((k) => k.public_key === pub) ? ['OK', `quorum ${id}`] : ['FAIL', "PRIVY_BACKEND_AUTH_KEY isn't a key on that quorum"];
});

// ---- this host -------------------------------------------------------------------
await check('dev auth is off', async () =>
  process.env.DEV_AUTH === '1' ? ['FAIL', 'DEV_AUTH=1 lets anyone sign in as anyone; never set it on a server'] : 'OK',
);
await check('NODE_ENV', async () => (process.env.NODE_ENV === 'production' ? 'OK' : ['WARN', 'set NODE_ENV=production on a server (dev auth is then impossible)']));
await check('key sealing secret', async () =>
  /^[0-9a-fA-F]{64}$/.test(process.env.KEY_ENCRYPTION_SECRET ?? '') ? 'OK' : ['FAIL', 'KEY_ENCRYPTION_SECRET must be 32 bytes of hex; losing it loses every Perpl key'],
);
await check('database path is writable (and on a persistent disk)', async () => {
  const dir = dirname(env.dbPath);
  if (existsSync(dir)) accessSync(dir, constants.W_OK);
  return ['OK', `${env.dbPath}${existsSync(env.dbPath) ? '' : ' (will be created)'}; it must survive restarts and redeploys`];
});
await check('CORS / public URL', async () => {
  const local = env.corsOrigins.every((o) => /localhost|127\.0\.0\.1/.test(o));
  if (local) return ['WARN', `CORS_ORIGINS is only ${env.corsOrigins.join(',')}; add the deployed frontend's origin`];
  return process.env.PUBLIC_APP_URL ? ['OK', env.corsOrigins.join(',')] : ['WARN', 'PUBLIC_APP_URL unset (share links)'];
});
await check('indexer (verified track records)', async () => {
  const src = process.env.INDEXER_GRAPHQL_URL ? 'GraphQL' : process.env.INDEXER_PG_URL ? 'Postgres' : null;
  if (!src) return ['WARN', 'neither INDEXER_GRAPHQL_URL nor INDEXER_PG_URL set; members show as unverified'];
  const { statsFor } = await import('../src/indexer/stats.js');
  const probe = '0x0000000000000000000000000000000000000000';
  const warn = console.warn;
  let failed = '';
  console.warn = (...a: unknown[]) => (failed = a.join(' '));
  await statsFor([probe]).finally(() => (console.warn = warn));
  if (failed) return ['FAIL', `${src}: ${failed}`];
  return process.env.INDEXER_API_KEY ? ['OK', `reads Trader via ${src}`] : ['WARN', `reads Trader via ${src}; INDEXER_API_KEY unset, so /v1/indexer/* (mirror labels) is closed`];
});
await check('test-only secrets absent', async () =>
  process.env.FUNDER_PRIVATE_KEY ? ['WARN', 'FUNDER_PRIVATE_KEY is for test scripts; leave it off servers'] : 'OK',
);
await check('mirror opt-out window', async () =>
  env.mirrorOptOutSeconds === 20 ? ['OK', '20s (still provisional)'] : ['OK', `${env.mirrorOptOutSeconds}s`],
);

const fails = results.filter((r) => r.level === 'FAIL').length;
const warns = results.filter((r) => r.level === 'WARN').length;
console.log(`\n${fails} FAIL, ${warns} WARN, ${results.length - fails - warns} OK`);
process.exit(fails ? 1 : 0);
