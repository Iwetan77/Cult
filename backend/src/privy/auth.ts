import { createRemoteJWKSet, jwtVerify } from 'jose';

// Privy access tokens are ES256 JWTs: iss "privy.io", aud = app id, sub = the
// user's Privy DID. Verified against the app's JWKS, no shared secret needed.
// The embedded wallet address isn't in the token, so it's looked up once via
// Privy's REST API with the app secret.

export interface PrivyIdentity {
  userId: string; // Privy DID
  wallet: string | null; // embedded wallet address
  walletId: string | null; // Privy wallet id (for server-side signing under policy)
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function appId(): string {
  const id = process.env.PRIVY_APP_ID;
  if (!id) throw new Error('PRIVY_APP_ID not set');
  return id;
}

export async function verifyPrivyToken(token: string): Promise<string> {
  jwks ??= createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId()}/jwks.json`));
  const { payload } = await jwtVerify(token, jwks, { issuer: 'privy.io', audience: appId() });
  if (!payload.sub) throw new Error('privy token has no sub');
  return payload.sub;
}

interface PrivyLinkedAccount {
  type: string;
  address?: string;
  chain_type?: string;
  wallet_client_type?: string;
  id?: string;
}

const walletCache = new Map<string, { at: number; wallet: string | null; walletId: string | null }>();

export async function privyEmbeddedWallet(userId: string): Promise<{ wallet: string | null; walletId: string | null }> {
  const hit = walletCache.get(userId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return { wallet: hit.wallet, walletId: hit.walletId };
  const secret = process.env.PRIVY_APP_SECRET;
  if (!secret) throw new Error('PRIVY_APP_SECRET not set');
  const res = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${appId()}:${secret}`).toString('base64'),
      'privy-app-id': appId(),
    },
  });
  if (!res.ok) throw new Error(`privy users/${userId} -> ${res.status}`);
  const user = (await res.json()) as { linked_accounts?: PrivyLinkedAccount[] };
  const embedded = (user.linked_accounts ?? []).find(
    (a) => a.type === 'wallet' && a.chain_type === 'ethereum' && a.wallet_client_type === 'privy',
  );
  const out = { wallet: embedded?.address ?? null, walletId: embedded?.id ?? null };
  walletCache.set(userId, { at: Date.now(), ...out });
  return out;
}

export async function identify(authorization: string | undefined): Promise<PrivyIdentity> {
  // Local scripts/tests only: never honoured in production.
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH === '1' && authorization?.startsWith('Dev ')) {
    const [userId, wallet] = authorization.slice(4).split(' ');
    return { userId: userId!, wallet: wallet ?? null, walletId: null };
  }
  if (!authorization?.startsWith('Bearer ')) throw new AuthError('missing bearer token');
  let userId: string;
  try {
    userId = await verifyPrivyToken(authorization.slice(7));
  } catch (e) {
    throw new AuthError(`invalid privy token: ${(e as Error).message}`);
  }
  const { wallet, walletId } = await privyEmbeddedWallet(userId);
  return { userId, wallet, walletId };
}

export class AuthError extends Error {}
