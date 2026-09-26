import 'dotenv/config';

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see backend/.env.example)`);
  return v;
}

export const env = {
  perplApiUrl: opt('PERPL_API_URL', 'https://testnet.perpl.xyz/api'),
  perplWsUrl: opt('PERPL_WS_URL', 'wss://testnet.perpl.xyz'),
  // Only set once Perpl whitelists our origin; testnet accepts server calls without one.
  perplOrigin: process.env.PERPL_ORIGIN || '',
  chainId: Number(opt('PERPL_CHAIN_ID', '10143')),
  rpcUrl: opt('ALCHEMY_MONAD_RPC_URL', 'https://testnet-rpc.monad.xyz'),
  dbPath: opt('DB_PATH', 'data/cult.db'),
  port: Number(opt('PORT', '8787')),
  // PROVISIONAL: product hasn't set the opt-out window. See CONTRACTS.md.
  mirrorOptOutSeconds: Number(opt('MIRROR_OPT_OUT_SECONDS', '20')),
  indexerApiKey: process.env.INDEXER_API_KEY || '',
  corsOrigins: opt('CORS_ORIGINS', 'http://localhost:3000').split(','),
};
