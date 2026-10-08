// A new account's embedded wallet is created just after sign-in. Looking it up
// in between must not stick: the next request finds it. Both of Privy's
// embedded-wallet labels count.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PRIVY_APP_ID = 'app-test';
process.env.PRIVY_APP_SECRET = 'secret-test';

const { privyEmbeddedWallet } = await import('../src/privy/auth.js');

const realFetch = globalThis.fetch;
const answer = (linked: object[]) => { globalThis.fetch = (async () => new Response(JSON.stringify({ linked_accounts: linked }))) as typeof fetch; };
const embedded = (client: string) => ({ type: 'wallet', chain_type: 'ethereum', wallet_client_type: client, address: '0xAbC0000000000000000000000000000000000001', id: 'w-1' });

test('no wallet yet is asked again, not remembered', async () => {
  try {
    answer([{ type: 'google_oauth' }]);
    assert.deepEqual(await privyEmbeddedWallet('did:privy:new'), { wallet: null, walletId: null });
    answer([{ type: 'google_oauth' }, embedded('privy')]);
    assert.deepEqual(await privyEmbeddedWallet('did:privy:new'), { wallet: '0xAbC0000000000000000000000000000000000001', walletId: 'w-1' });
  } finally { globalThis.fetch = realFetch; }
});

test('a found wallet is remembered', async () => {
  try {
    answer([]); // would be "none" if asked again
    assert.equal((await privyEmbeddedWallet('did:privy:new')).wallet, '0xAbC0000000000000000000000000000000000001');
  } finally { globalThis.fetch = realFetch; }
});

test('newer embedded wallets (privy-v2) count', async () => {
  try {
    answer([embedded('privy-v2')]);
    assert.equal((await privyEmbeddedWallet('did:privy:v2')).walletId, 'w-1');
    answer([{ ...embedded('metamask'), id: undefined }]);
    assert.equal((await privyEmbeddedWallet('did:privy:external')).wallet, null);
  } finally { globalThis.fetch = realFetch; }
});
