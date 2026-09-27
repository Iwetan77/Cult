// Privy login path against the real app (no user login needed):
//  1. the embedded-wallet lookup: create a throwaway Privy user with an
//     embedded Ethereum wallet, check privyEmbeddedWallet() returns exactly
//     that address + wallet id, delete the user
//  2. token verification with the app's real JWKS: a forged ES256 token, a
//     garbage token and no token must all be refused
import '../../src/config/env.js';
import { SignJWT, generateKeyPair } from 'jose';
import { identify, privyEmbeddedWallet } from '../../src/privy/auth.js';
import { privy } from '../../src/privy/policy.js';

let failed = false;
const p = privy();
const u: any = await p.users().create({ linked_accounts: [{ type: 'email', address: `cult-e2e-${Date.now()}@example.com` }], wallets: [{ chain_type: 'ethereum' }] } as any);
try {
  const embedded = (u.linked_accounts ?? []).find((a: any) => a.type === 'wallet' && a.chain_type === 'ethereum');
  const got = await privyEmbeddedWallet(u.id);
  const ok = got.wallet?.toLowerCase() === embedded?.address?.toLowerCase() && got.walletId === embedded?.id && !!got.walletId;
  console.log(ok ? 'OK  ' : 'FAIL', `embedded wallet lookup for ${u.id}:`, JSON.stringify(got));
  failed ||= !ok;
} finally {
  await (p.users() as any).delete(u.id).catch(() => undefined);
}

const { privateKey } = await generateKeyPair('ES256');
const forged = await new SignJWT({ sid: 'x' }).setProtectedHeader({ alg: 'ES256', kid: 'forged' }).setIssuer('privy.io').setAudience(process.env.PRIVY_APP_ID!).setSubject('did:privy:attacker').setIssuedAt().setExpirationTime('1h').sign(privateKey);
for (const [label, header] of [['forged ES256 token', `Bearer ${forged}`], ['garbage token', 'Bearer abc.def.ghi'], ['no token', undefined]] as const) {
  try {
    await identify(header);
    console.log('FAIL', label, 'was accepted');
    failed = true;
  } catch (e) {
    console.log('OK  ', label, 'refused:', (e as Error).message.slice(0, 80));
  }
}
process.exitCode = failed ? 1 : 0;
