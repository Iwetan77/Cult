// Cross-chain money in/out on Aurora Intents: the quote we ask for (who gets
// paid, where refunds go), chain listing, address checks, status ownership.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);
process.env.PERPL_CHAIN_ID = '143';
process.env.AURORA_INTENTS_API_KEY = 'test-key';

const TOKENS = [
  { assetId: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx', decimals: 6, blockchain: 'monad', symbol: 'USDC', price: 1, contractAddress: '0x754704bc059f8c67012fed69bc8a327a5aafb603' },
  { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', price: 150, contractAddress: null },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', price: 1, contractAddress: null },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 60000, contractAddress: null },
  { assetId: 'nep141:base.omft.near', decimals: 18, blockchain: 'base', symbol: 'ETH', price: 2500, contractAddress: null },
];

let calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
let statusReply: Record<string, unknown> = { status: 'PROCESSING', updatedAt: '' };
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (url.includes('/api/tokens/')) return Response.json({ tokens: TOKENS, asset_stats: [] });
    if (url.includes('/api/quote/')) {
      return Response.json({
        correlationId: 'c1',
        quote: { timeEstimate: 40, deadline: '2026-10-05T12:00:00Z', depositAddress: 'So1anaDepositAddr1111111111111111111111111', amountIn: '1000000000', amountInFormatted: '1', amountInUsd: '150', amountOut: '149500000', amountOutFormatted: '149.5', amountOutUsd: '149.5', minAmountOut: '148000000' },
      });
    }
    if (url.includes('/api/status/')) return Response.json(statusReply);
    if (url.includes('/api/deposit/submit/')) return Response.json({});
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

let members: typeof import('../src/store/members.js')['members'];
let X: typeof import('../src/intents/crosschain.js');
let A: typeof import('../src/intents/aurora.js');
const WALLET = '0x' + 'ab'.repeat(20);

before(async () => {
  ({ members } = await import('../src/store/members.js'));
  X = await import('../src/intents/crosschain.js');
  A = await import('../src/intents/aurora.js');
  members.upsert('U', WALLET);
  members.upsert('OTHER', '0x' + 'cd'.repeat(20));
});

test('chains: grouped, Monad left out, popular coins first', async () => {
  A.resetTokenCache();
  const chains = await X.chainOptions();
  assert.deepEqual(chains.map((c) => c.chain), ['btc', 'sol', 'base']);
  assert.deepEqual(chains.find((c) => c.chain === 'sol')!.tokens.map((t) => t.symbol), ['USDC', 'SOL']);
  assert.equal(chains.find((c) => c.chain === 'base')!.evm, true);
  assert.ok(calls[0]!.url.endsWith('/api/tokens/test-key'));
});

test('deposit from Solana: USDC to the Cult wallet on Monad, refunds to their Intents account', async () => {
  A.resetTokenCache();
  const v = await X.depositQuote('U', { originAsset: 'nep141:sol.omft.near', amount: '1' });
  const q = calls.find((c) => c.url.includes('/api/quote/'))!.body!;
  assert.equal(q.originAsset, 'nep141:sol.omft.near');
  assert.equal(q.destinationAsset, TOKENS[0]!.assetId);
  assert.equal(q.amount, '1000000000');
  assert.equal(q.recipientType, 'DESTINATION_CHAIN');
  assert.equal(String(q.recipient).toLowerCase(), WALLET);
  assert.equal(q.refundType, 'INTENTS');
  assert.equal(q.refundTo, WALLET);
  assert.equal(q.referral, 'cult');
  assert.equal(q.dry, false);
  assert.equal(v.depositAddress, 'So1anaDepositAddr1111111111111111111111111');
  assert.equal(v.chainName, 'Solana');
  assert.equal(v.receiveSymbol, 'USDC');
  assert.equal(v.receiveUsd, 149.5);
});

test('deposit from an EVM chain refunds to the same address there; an explicit refund address wins', async () => {
  A.resetTokenCache();
  await X.depositQuote('U', { originAsset: 'nep141:base.omft.near', amount: '0.01' });
  let q = calls.find((c) => c.url.includes('/api/quote/'))!.body!;
  assert.equal(q.refundType, 'ORIGIN_CHAIN');
  assert.equal(String(q.refundTo).toLowerCase(), WALLET);
  assert.equal(q.amount, '10000000000000000');
  calls = [];
  await X.depositQuote('U', { originAsset: 'nep141:btc.omft.near', amount: '0.001', refundTo: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' });
  q = calls.find((c) => c.url.includes('/api/quote/'))!.body!;
  assert.equal(q.refundType, 'ORIGIN_CHAIN');
  assert.equal(q.refundTo, 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
  await assert.rejects(X.depositQuote('U', { originAsset: 'nep141:btc.omft.near', amount: '0.001', refundTo: 'not-an-address' }), /doesn't look like a Bitcoin address/);
  await assert.rejects(X.depositQuote('U', { originAsset: TOKENS[0]!.assetId, amount: '5' }), /already on Monad/);
  await assert.rejects(X.depositQuote('U', { originAsset: 'nep141:sol.omft.near', amount: 'abc' }), /Enter an amount/);
});

test('status: only the member who asked can follow a transfer', async () => {
  A.resetTokenCache();
  const v = await X.depositQuote('U', { originAsset: 'nep141:sol.omft.near', amount: '1' });
  statusReply = { status: 'SUCCESS', updatedAt: 'now', swapDetails: { amountOutFormatted: '149.4', amountOutUsd: '149.4', destinationChainTxHashes: [{ hash: '0xabc', explorerUrl: 'https://x/0xabc' }] } };
  const s = await X.swapStatus('U', v.depositAddress);
  assert.deepEqual({ status: s.status, done: s.done, received: s.received, txs: s.txs }, { status: 'SUCCESS', done: true, received: '149.4', txs: [{ hash: '0xabc', url: 'https://x/0xabc' }] });
  await assert.rejects(X.swapStatus('OTHER', v.depositAddress), /Unknown transfer/);
  assert.deepEqual((X.recentSwaps('U') as Array<{ status: string }>)[0]!.status, 'SUCCESS');
});

test('recipient checks per chain', () => {
  assert.equal(X.validRecipient('base', '0x' + '1'.repeat(40)), true);
  assert.equal(X.validRecipient('base', 'nope'), false);
  assert.equal(X.validRecipient('sol', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), true);
  assert.equal(X.validRecipient('tron', 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'), true);
  assert.equal(X.validRecipient('btc', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'), true);
  assert.equal(X.validRecipient('sui', '0x' + 'a'.repeat(64)), true);
  assert.equal(X.validRecipient('ton', 'has space'), false);
});

test('Aurora errors come back readable', async () => {
  globalThis.fetch = (async () => Response.json({ message: 'Amount is too low for bridge, try at least 1000000' }, { status: 400 })) as typeof fetch;
  await assert.rejects(A.quote({ dry: true, swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', originAsset: 'a', destinationAsset: 'b', amount: '1', slippageTolerance: 100, refundTo: 'r', refundType: 'ORIGIN_CHAIN', recipient: 'x', recipientType: 'DESTINATION_CHAIN' }), (e: unknown) => e instanceof A.IntentsError && e.status === 400 && /too low/.test(e.message));
  globalThis.fetch = realFetch;
});
