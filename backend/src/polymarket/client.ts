import {
  createPublicClient,
  createSecureClient,
  forkEnvironmentConfig,
  production,
  type EnvironmentConfig,
  type SecureClient,
  type PublicClient,
} from '@polymarket/client';
import { builderApiKey } from '@polymarket/client/node';
import { privateKey } from '@polymarket/client/viem';
import { strEnv } from '../config/env.js';
import { predictionAccounts, type ClobCreds } from './store.js';
import type { BrowserSigner } from './broker.js';

// Polymarket (predictions) settings and SDK clients.
//
// POLYMARKET_BUILDER_API_KEY / _SECRET / _PASSPHRASE: Cult's builder account
// (polymarket.com -> Settings -> Builders). Needed to open members' Deposit
// Wallets and send their wallet steps gasless; without them predictions stay
// read-only. Session keys (trading without a signature per bet) also need
// Polymarket to enable session-key management on that builder key.
// POLYGON_RPC_URL: optional; the SDK's public default otherwise.

export function builderCreds(): { key: string; secret: string; passphrase: string } | null {
  const key = strEnv('POLYMARKET_BUILDER_API_KEY', '');
  const secret = strEnv('POLYMARKET_BUILDER_SECRET', '');
  const passphrase = strEnv('POLYMARKET_BUILDER_PASSPHRASE', '');
  return key && secret && passphrase ? { key, secret, passphrase } : null;
}

export const predictionsEnabled = () => strEnv('PREDICTIONS', 'on') !== 'off' && !!builderCreds();
// Off (default): no session key; each bet is signed by the member's Privy
// wallet in the browser, without a pop-up. On: setup also authorizes a CLOB
// session key (Polymarket must enable it for our builder key).
export const sessionKeysWanted = () => strEnv('POLYMARKET_SESSION_KEYS', 'off') === 'on';

// pUSD, Polymarket's collateral on Polygon (6 decimals).
export const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
export const polygonRpc = () => strEnv('POLYGON_RPC_URL', 'https://polygon.drpc.org');

let environment: EnvironmentConfig | null = null;
export function polymarketEnv(): EnvironmentConfig {
  if (environment) return environment;
  const rpc = strEnv('POLYGON_RPC_URL', '');
  environment = rpc ? forkEnvironmentConfig({ name: 'production', rpc }) : production;
  return environment;
}

let pub: PublicClient | null = null;
export function publicClient(): PublicClient {
  return (pub ??= createPublicClient({ environment: polymarketEnv() }) as PublicClient);
}

// The member's own wallet, signing in their browser through the broker. Opens
// (and deploys) their Deposit Wallet; with stored credentials it skips the
// sign-in signature.
export async function ownerClient(userId: string, signer: BrowserSigner, wallet?: string): Promise<SecureClient> {
  const builder = builderCreds();
  const creds = predictionAccounts.creds(userId);
  const client = await createSecureClient({
    environment: polymarketEnv(),
    signer: signer as never,
    ...(wallet ? { wallet } : {}),
    ...(builder ? { apiKey: builderApiKey(builder) } : {}),
    ...(creds ? { credentials: creds } : {}),
  } as never);
  const fresh = client.credentials as ClobCreds;
  if (!creds || creds.key !== fresh.key) predictionAccounts.setCreds(userId, fresh);
  return client as SecureClient;
}

// Our session key for the member's Deposit Wallet (trade only). Cached while
// the process lives; null when the member has none.
const sessions = new Map<string, { client: SecureClient; at: number }>();
export async function sessionClient(userId: string): Promise<SecureClient | null> {
  const acct = predictionAccounts.get(userId);
  const key = predictionAccounts.sessionKey(userId);
  if (!acct || !key) return null;
  const hit = sessions.get(userId);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.client;
  const client = (await createSecureClient({ environment: polymarketEnv(), signer: privateKey(key), wallet: acct.depositWallet } as never)) as SecureClient;
  sessions.set(userId, { client, at: Date.now() });
  return client;
}

export function forgetSession(userId: string) {
  sessions.delete(userId);
}
