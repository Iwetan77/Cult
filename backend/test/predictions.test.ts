// Predictions (Polymarket): the browser-signature broker, the location gate,
// price protection, bet bookkeeping and who sees whose bets.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

type Broker = typeof import('../src/polymarket/broker.js');
let B: Broker;

before(async () => {
  B = await import('../src/polymarket/broker.js');
});

const wallet = ethers.Wallet.createRandom();
const typed = {
  domain: { name: 'ClobAuthDomain', version: '1', chainId: 137n },
  types: { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] },
  primaryType: 'ClobAuth',
  message: { address: wallet.address, nonce: 0n, message: 'This message attests that I control the given wallet' },
};

async function signJson(td: import('../src/polymarket/broker.js').TypedDataJson, w: ethers.HDNodeWallet | ethers.Wallet) {
  const { EIP712Domain: _d, ...types } = td.types;
  return w.signTypedData(td.domain as ethers.TypedDataDomain, types, td.message);
}

test('a flow stops for the browser signature, then finishes with it', async () => {
  const broker = new B.SignatureBroker();
  let got = '';
  const first = await broker.start('u1', wallet.address, 'test', async (signer) => {
    got = await signer.signTypedData(typed);
    return 'ok';
  });
  assert.equal(first.status, 'needs_signature');
  if (first.status !== 'needs_signature') return;
  const req = first.signature;
  assert.equal(req.kind, 'typedData');
  // JSON-safe for the browser: bigints as strings, EIP712Domain included.
  assert.equal(req.typedData!.domain.chainId, '137');
  assert.deepEqual(req.typedData!.types.EIP712Domain!.map((f) => f.name), ['name', 'version', 'chainId']);
  assert.ok(JSON.stringify(req));
  const sig = await signJson(req.typedData!, wallet);
  const done = await broker.resume('u1', first.flowId, req.challengeId, sig);
  assert.deepEqual(done, { status: 'done', flowId: first.flowId, result: 'ok' });
  assert.equal(got, sig);
});

test('a signature from another wallet is refused and the flow keeps waiting', async () => {
  const broker = new B.SignatureBroker();
  const first = await broker.start('u2', wallet.address, 'test', async (signer) => signer.signTypedData(typed));
  assert.equal(first.status, 'needs_signature');
  if (first.status !== 'needs_signature') return;
  const other = ethers.Wallet.createRandom();
  await assert.rejects(broker.resume('u2', first.flowId, first.signature.challengeId, await signJson(first.signature.typedData!, other)), (e: unknown) => e instanceof B.FlowError && e.status === 403);
  // Asking again returns the same request.
  const again = await broker.poll('u2', first.flowId);
  assert.equal(again.status, 'needs_signature');
  if (again.status === 'needs_signature') assert.equal(again.signature.challengeId, first.signature.challengeId);
  const ok = await broker.resume('u2', first.flowId, first.signature.challengeId, await signJson(first.signature.typedData!, wallet));
  assert.equal(ok.status, 'done');
});

test("another member can't answer someone's flow", async () => {
  const broker = new B.SignatureBroker();
  const first = await broker.start('u3', wallet.address, 'test', async (signer) => signer.signTypedData(typed));
  if (first.status !== 'needs_signature') return assert.fail('expected a signature step');
  await assert.rejects(broker.resume('intruder', first.flowId, first.signature.challengeId, '0x00'), (e: unknown) => e instanceof B.FlowError && e.status === 404);
});

test('several signatures in a row, and personal_sign messages', async () => {
  const broker = new B.SignatureBroker();
  let step = await broker.start('u4', wallet.address, 'test', async (signer) => {
    const a = await signer.signTypedData(typed);
    const b = await signer.signMessage(ethers.hexlify(ethers.toUtf8Bytes('hello')) as `0x${string}`);
    return [a, b];
  });
  const signed: string[] = [];
  while (step.status === 'needs_signature') {
    const r = step.signature;
    const sig = r.kind === 'typedData' ? await signJson(r.typedData!, wallet) : await wallet.signMessage(ethers.getBytes(r.message!));
    signed.push(sig);
    step = await broker.resume('u4', step.flowId, r.challengeId, sig);
  }
  assert.equal(step.status, 'done');
  if (step.status === 'done') assert.deepEqual(step.result, signed);
});

test('a failing flow reports its error to the caller', async () => {
  const broker = new B.SignatureBroker();
  await assert.rejects(broker.start('u5', wallet.address, 'test', async () => { throw new B.FlowError(409, 'nope'); }), /nope/);
});

test('starting a new flow cancels the old one', async () => {
  const broker = new B.SignatureBroker();
  const first = await broker.start('u6', wallet.address, 'test', async (signer) => signer.signTypedData(typed));
  assert.equal(first.status, 'needs_signature');
  await broker.start('u6', wallet.address, 'test', async () => 'second');
  await assert.rejects(broker.poll('u6', first.flowId), (e: unknown) => e instanceof B.FlowError);
});

test('labels say what is being signed', async () => {
  const { labelFor } = await import('../src/polymarket/account.js');
  const t = (domain: Record<string, unknown>, message: Record<string, unknown> = {}) => labelFor({ domain, types: {}, primaryType: 'X', message });
  assert.equal(t({ name: 'ClobAuthDomain' }), 'Sign in to Polymarket');
  assert.equal(t({ name: 'Polymarket CTF Exchange' }), 'Confirm your bet');
  const session = ethers.id('authorizeSessionSigner(address,uint256)').slice(0, 10);
  assert.match(t({ name: 'DepositWallet' }, { calls: [{ data: session + '00' }] }), /place your bets/);
  assert.equal(t({ name: 'DepositWallet' }, { calls: [{ data: '0x095ea7b3' }, { data: '0xa22cb465' }] }), 'Turn on trading for your account');
  assert.equal(t({ name: 'DepositWallet' }, { calls: [{ data: '0xa9059cbb' }] }), 'Move your dollars');
});

test('location gate follows Polymarket: blocked, close-only, open', async () => {
  const { accessFor } = await import('../src/polymarket/geo.js');
  assert.deepEqual(accessFor('NG'), { country: 'NG', predictions: 'open', perps: 'open' });
  assert.equal(accessFor('US').predictions, 'close_only');
  assert.equal(accessFor('us').perps, 'blocked');
  assert.equal(accessFor('GB').predictions, 'close_only');
  assert.equal(accessFor('GB').perps, 'open');
  assert.equal(accessFor('IR').predictions, 'blocked');
  assert.equal(accessFor(null).predictions, 'open');
});

test('IP lookups: first answer wins, private IPs skip, failures fall through', async () => {
  const { countryOfIp } = await import('../src/polymarket/geo.js');
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    if (url.includes('country.is')) return new Response('nope', { status: 500 });
    return Response.json({ country_code: 'ng' });
  }) as typeof fetch;
  assert.equal(await countryOfIp('41.58.1.1', fake), 'NG');
  assert.equal(calls.length, 2);
  assert.equal(await countryOfIp('41.58.1.1', fake), 'NG'); // cached
  assert.equal(calls.length, 2);
  assert.equal(await countryOfIp('10.0.0.4', fake), null);
  assert.equal(await countryOfIp(null, fake), null);
});

test('price protection stays on the tick grid and inside (0, 1)', async () => {
  const { protectedPrice } = await import('../src/polymarket/markets.js');
  assert.equal(protectedPrice(0.52, 'buy', 0.01, 0.05), 0.55);
  assert.equal(protectedPrice(0.52, 'sell', 0.01, 0.05), 0.49);
  assert.equal(protectedPrice(0.98, 'buy', 0.01, 0.05), 0.99);
  assert.equal(protectedPrice(0.004, 'sell', 0.001, 0.05), 0.003);
  assert.equal(protectedPrice(0.01, 'sell', 0.01, 0.05), 0.01);
});

test('Gamma markets map Yes/No tokens, tick and size', async () => {
  const { toPmMarket } = await import('../src/polymarket/markets.js');
  const m = toPmMarket({
    id: '601819', question: 'Will Lula win?', conditionId: '0xabc', groupItemTitle: 'Lula',
    outcomes: '["Yes", "No"]', outcomePrices: '["0.165", "0.835"]', clobTokenIds: '["111", "222"]',
    negRisk: true, orderPriceMinTickSize: 0.01, orderMinSize: 5, active: true, closed: false, acceptingOrders: true,
  })!;
  assert.equal(m.yesToken, '111');
  assert.equal(m.noToken, '222');
  assert.equal(m.label, 'Lula');
  assert.equal(m.yesPrice, 0.165);
  assert.equal(m.negRisk, true);
  assert.equal(m.tradable, true);
  assert.equal(toPmMarket({ id: '1', question: 'q', conditionId: '0x1', clobTokenIds: '[]' }), null);
});

test('bets add up per outcome; a part sale cuts cost pro rata; a full sale closes', async () => {
  const { members } = await import('../src/store/members.js');
  const { predictionPositions } = await import('../src/polymarket/store.js');
  const { toApi } = await import('../src/polymarket/trading.js');
  members.upsert('P', `0x${'1'.repeat(40)}`);
  const fill = { marketId: '9', conditionId: '0xc', tokenId: 't-yes', side: 'yes' as const, sideLabel: 'Yes', eventSlug: 'ev', eventTitle: 'Ev', outcomeLabel: 'Q?', question: 'Q?', image: null, negRisk: false, cultIds: null };
  const a = predictionPositions.addFill('P', { ...fill, shares: 100, costUsd: 40 });
  const b = predictionPositions.addFill('P', { ...fill, shares: 100, costUsd: 60 });
  assert.equal(a.id, b.id);
  assert.equal(toApi(b).avgPrice, 0.5);
  const part = predictionPositions.sell(a.id, 50, 35);
  assert.deepEqual(part, { closed: false, costOfSold: 25 });
  const left = predictionPositions.get(a.id)!;
  assert.equal(left.shares, 150);
  assert.equal(left.costUsd, 75);
  const all = predictionPositions.sell(a.id, 150, 120);
  assert.equal(all.closed, true);
  const closed = predictionPositions.get(a.id)!;
  assert.ok(closed.closedAt);
  assert.equal(closed.proceedsUsd, 155);
  assert.equal(predictionPositions.open('P').length, 0);
});

test("cult bets: only mates in a shared cult, only where they posted it", async () => {
  const { members } = await import('../src/store/members.js');
  const { clans } = await import('../src/store/clans.js');
  const { predictionPositions } = await import('../src/polymarket/store.js');
  const { cultBets } = await import('../src/polymarket/trading.js');
  for (const u of ['ME', 'MATE', 'STRANGER', 'SHY']) members.upsert(u, `0x${Buffer.from(u).toString('hex').padEnd(40, '0').slice(0, 40)}`);
  const off = { enabled: false, balancePercentCap: 10, maxUsdPerTrade: 100 };
  const a = clans.create('alpha', 'ME', off).id;
  const b = clans.create('beta', 'STRANGER', off).id;
  clans.join(a, 'MATE', off);
  clans.join(a, 'SHY', off);
  clans.join(b, 'SHY', off);
  const fill = { marketId: '7', conditionId: '0xd', side: 'no' as const, sideLabel: 'No', eventSlug: 'fed', eventTitle: 'Fed', outcomeLabel: 'Cut', question: 'Cut?', image: null, negRisk: true, shares: 10, costUsd: 4 };
  predictionPositions.addFill('MATE', { ...fill, tokenId: 'm', cultIds: null });
  predictionPositions.addFill('STRANGER', { ...fill, tokenId: 's', cultIds: null });
  predictionPositions.addFill('SHY', { ...fill, tokenId: 'y', cultIds: [b] }); // posted to beta only
  predictionPositions.addFill('ME', { ...fill, tokenId: 'me', cultIds: null });
  const bets = cultBets('ME', 'fed');
  assert.deepEqual(bets.map((x) => x.memberId), ['MATE']);
  assert.equal(bets[0]!.cultName, 'alpha');
  assert.equal(bets[0]!.avgPrice, 0.4);
});

test('session keys are sealed at rest and expire', async () => {
  const { members } = await import('../src/store/members.js');
  const { predictionAccounts } = await import('../src/polymarket/store.js');
  const { getDb } = await import('../src/store/db.js');
  members.upsert('S', `0x${'2'.repeat(40)}`);
  predictionAccounts.ensure('S', `0x${'2'.repeat(40)}`, `0x${'3'.repeat(40)}`);
  const key = `0x${'ab'.repeat(32)}`;
  predictionAccounts.setSession('S', `0x${'4'.repeat(40)}`, key, Math.floor(Date.now() / 1000) + 3600);
  const raw = getDb().prepare('SELECT session_key FROM prediction_accounts WHERE user_id = ?').get('S') as { session_key: string };
  assert.ok(!raw.session_key.includes('abab'));
  assert.equal(predictionAccounts.sessionKey('S'), key);
  predictionAccounts.setSession('S', `0x${'4'.repeat(40)}`, key, Math.floor(Date.now() / 1000) + 10);
  assert.equal(predictionAccounts.sessionKey('S'), null); // about to expire: not used
  predictionAccounts.setCreds('S', { key: 'k', secret: 's', passphrase: 'p' });
  assert.deepEqual(predictionAccounts.creds('S'), { key: 'k', secret: 's', passphrase: 'p' });
  // A new owner wallet starts the account over.
  predictionAccounts.ensure('S', `0x${'5'.repeat(40)}`, `0x${'6'.repeat(40)}`);
  assert.equal(predictionAccounts.creds('S'), null);
});
