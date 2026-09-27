// The production signing path, for real on testnet: the backend's own Privy
// signer (PRIVY_BACKEND_AUTH_KEY / _KEY_QUORUM_ID), attached to a member's
// Privy wallet under that member's policy, makes a real Nad.fun buy and sell.
// Privy signs, we broadcast. An over-cap buy must be refused by Privy (nothing
// reaches the chain). The member key (the wallet owner) sweeps leftovers back.
import '../../src/config/env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { generateP256KeyPair } from '@privy-io/node';
import { env, required } from '../../src/config/env.js';
import { rpc } from '../../src/chain/signer.js';
import { NADFUN } from '../../src/nadfun/constants.js';
import { buy, listMonMarkets, quoteBuy, sell, tokenBalance } from '../../src/nadfun/trading.js';
import { getExchangeInfo } from '../../src/perpl/context.js';
import { buildBackendPolicy, privy, PrivyPolicySigner } from '../../src/privy/policy.js';
import { KURU_FLOW_ROUTER } from '../../src/swap/kuruFlow.js';
import { funder } from './fund.js';

const SEED = ethers.parseEther('0.35');
const CAP = ethers.parseEther('0.05'); // per-buy MON cap in this member's policy
const BUY = ethers.parseEther('0.02');
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };
let owner: PrivyPolicySigner | undefined;

try {
  const p = privy();
  const { exchange, collateralToken } = await getExchangeInfo();
  const member = await generateP256KeyPair(); // stand-in for the user owner
  const wallet = await p.wallets().create({ chain_type: 'ethereum', owner: { public_key: member.publicKey } });
  const policy = await p.policies().create(
    buildBackendPolicy(
      {
        member: wallet.address,
        chainId: env.chainId,
        perplExchange: exchange,
        perplCollateral: collateralToken,
        maxDepositRaw: 50_000_000n,
        nadRouter: NADFUN.router,
        maxBuyWei: CAP,
        kuruRouter: KURU_FLOW_ROUTER,
        maxSellWei: CAP * 10n,
      },
      `cult-e2e-live-${Date.now()}`,
    ) as never,
  );
  // The member grants the backend's production signer, scoped by the policy.
  await p.wallets().update(wallet.id, {
    additional_signers: [{ signer_id: required('PRIVY_BACKEND_KEY_QUORUM_ID'), override_policy_ids: [policy.id] }],
    authorization_context: { authorization_private_keys: [member.privateKey] },
  } as never);
  const backend = new PrivyPolicySigner(wallet.id, wallet.address); // uses PRIVY_BACKEND_AUTH_KEY
  owner = new PrivyPolicySigner(wallet.id, wallet.address, member.privateKey);
  evidence.setup = { wallet: wallet.address, walletId: wallet.id, policyId: policy.id };
  console.log('privy wallet', wallet.address, 'policy', policy.id);

  const seedTx = await funder().sendTransaction({ to: wallet.address, data: '0x', value: SEED });
  evidence.seedTx = seedTx;

  let token = '';
  for (const m of await listMonMarkets('latest_trade', 100)) {
    if (!m.graduated && (await quoteBuy(m.token, BUY).catch(() => 0n)) > 0n) { token = m.token; break; }
  }
  if (!token) throw new Error('no MON-quoted curve token quoting a buy');
  evidence.token = token;

  // Over the cap: Privy must refuse before anything is broadcast.
  const nonceBefore = await rpc().getTransactionCount(wallet.address);
  let refused = '';
  await buy(backend, token, ethers.parseEther('0.06')).then(
    () => { throw new Error('GATE FAILED: over-cap buy went through'); },
    (e) => { refused = String(e?.message ?? e); },
  );
  if (!/policy/i.test(refused)) throw new Error(`over-cap buy failed for the wrong reason: ${refused}`);
  if ((await rpc().getTransactionCount(wallet.address)) !== nonceBefore) throw new Error('GATE FAILED: something was broadcast for the refused buy');
  console.log('OK   over-cap buy (0.06 > 0.05 MON) refused by Privy, nothing broadcast:', refused.slice(0, 80));
  evidence.overCapRefusal = refused.slice(0, 300);

  // Within the cap: real buy, signed by Privy under policy, broadcast by us.
  const b = await buy(backend, token, BUY);
  const held = await tokenBalance(token, wallet.address);
  console.log(`OK   backend-signed buy ${b.txHash}: ${ethers.formatEther(b.monAmount)} MON -> ${ethers.formatEther(b.tokenAmount)} tokens (wallet holds ${ethers.formatEther(held)})`);
  if (held !== b.tokenAmount) throw new Error('GATE FAILED: balance != bought amount');

  // Sell back, proceeds to the member (the policy pins `to`).
  const s = await sell(backend, token);
  const after = await tokenBalance(token, wallet.address);
  console.log(`OK   backend-signed sell ${s.txHash} (approve ${s.approveTx}): -> ${ethers.formatEther(s.monAmount)} MON, token balance ${after}`);
  if (after !== 0n) throw new Error('GATE FAILED: tokens left after sell');
  evidence.buy = { tx: b.txHash, mon: b.monAmount.toString(), tokens: b.tokenAmount.toString() };
  evidence.sell = { tx: s.txHash, approve: s.approveTx, mon: s.monAmount.toString() };
  evidence.result = 'pass';
  console.log('\nGATE OK: production Privy signer traded Nad.fun for real, within policy; over-cap refused');
} catch (e) {
  evidence.result = 'fail';
  evidence.error = String(e);
  console.error(e);
  process.exitCode = 1;
} finally {
  // The owner (member) isn't bound by the backend's policy: sweep MON back.
  if (owner) {
    try {
      const bal = await rpc().getBalance(owner.address);
      const fee = await rpc().getFeeData();
      const reserve = 21_000n * (fee.maxFeePerGas ?? ethers.parseUnits('250', 'gwei')) * 3n;
      if (bal > reserve * 2n) {
        const f = funder().address;
        const tx = await owner.sendTransaction({ to: f, data: '0x', value: bal - reserve });
        evidence.sweep = { tx, mon: ethers.formatEther(bal - reserve) };
        console.log('swept', ethers.formatEther(bal - reserve), 'MON back to the funder with the owner key');
      }
    } catch (e) {
      evidence.sweepError = String(e);
    }
  }
  mkdirSync('data/evidence', { recursive: true });
  const file = `data/evidence/privy-nadfun-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log('evidence ->', file);
}
