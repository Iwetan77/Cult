// Phase 3 gate: prove Privy's policy engine, not our code, stops the backend
// from exceeding the member's cap, withdrawing, or moving funds out, on both
// venues.
//
// Setup (all real Privy API calls):
//   - "member" P-256 key = stand-in for the user owner of the wallet
//   - "backend" P-256 key, registered as a 1-of-1 key quorum
//   - a wallet owned by the member key
//   - the per-member policy from src/privy/policy.ts (pins this wallet; $50 AUSD
//     cap; Nad.fun buy cap in MON), attached by the owner as an override policy
//     on the backend signer, the same way the frontend's addSigners() does it
// Then the backend key tries what it must not be able to do, and what it must
// (so a deny-all policy can't pass). Signing only, nothing broadcast: no funds.
import { mkdirSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { generateP256KeyPair } from '@privy-io/node';
import { env } from '../../src/config/env.js';
import { erc20Abi, exchangeAbi } from '../../src/chain/exchange.js';
import { NADFUN } from '../../src/nadfun/constants.js';
import { routerAbi } from '../../src/nadfun/trading.js';
import { flowAbi, KURU_FLOW_ROUTER } from '../../src/swap/kuruFlow.js';
import { getExchangeInfo } from '../../src/perpl/context.js';
import { buildBackendPolicy, privy } from '../../src/privy/policy.js';

const CAP_AUSD = 50n;
const MAX_BUY = ethers.parseEther('0.05');
const MAX_SELL = ethers.parseEther('0.5');
const MEME = '0x5e2E014020f31A410cC6Cd44dEfb646b02467777'; // TTT, the token spike C traded
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };
const results: { attempt: string; signer: string; expected: 'allow' | 'deny'; got: 'allow' | 'deny'; detail: string }[] = [];

try {
  const { exchange, collateralToken, collateralDecimals } = await getExchangeInfo();
  const unit = 10n ** BigInt(collateralDecimals);
  const p = privy();

  const member = await generateP256KeyPair();
  const backend = await generateP256KeyPair();
  const quorum = await p.keyQuorums().create({ public_keys: [backend.publicKey], authorization_threshold: 1, display_name: 'cult-backend-e2e' });
  const wallet = await p.wallets().create({ chain_type: 'ethereum', owner: { public_key: member.publicKey } });
  const policy = await p.policies().create(
    buildBackendPolicy(
      {
        member: wallet.address,
        chainId: env.chainId,
        perplExchange: exchange,
        perplCollateral: collateralToken,
        maxDepositRaw: CAP_AUSD * unit,
        nadRouter: NADFUN.router,
        maxBuyWei: MAX_BUY,
        kuruRouter: KURU_FLOW_ROUTER,
        maxSellWei: MAX_SELL,
      },
      `cult-e2e-${Date.now()}`,
    ) as never,
  );
  // The owner grants the backend signer, scoped by the policy.
  await p.wallets().update(wallet.id, {
    additional_signers: [{ signer_id: quorum.id, override_policy_ids: [policy.id] }],
    authorization_context: { authorization_private_keys: [member.privateKey] },
  } as never);
  console.log('wallet', wallet.address, 'policy', policy.id, 'backend quorum', quorum.id);
  evidence.setup = { walletId: wallet.id, address: wallet.address, policyId: policy.id, keyQuorumId: quorum.id, capAusd: CAP_AUSD.toString(), maxBuyMon: ethers.formatEther(MAX_BUY) };

  const stranger = ethers.Wallet.createRandom().address;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const tx = (to: string, data: string, value = 0n) => ({
    to,
    data: data as `0x${string}`,
    value: ethers.toQuantity(value),
    chain_id: ethers.toQuantity(env.chainId),
    nonce: '0x0',
    gas_limit: ethers.toQuantity(500_000),
    max_fee_per_gas: ethers.toQuantity(ethers.parseUnits('200', 'gwei')),
    max_priority_fee_per_gas: ethers.toQuantity(ethers.parseUnits('2', 'gwei')),
    type: 2 as const,
  });

  async function attempt(name: string, who: 'backend' | 'member', expected: 'allow' | 'deny', run: (key: string) => Promise<unknown>) {
    const key = who === 'backend' ? backend.privateKey : member.privateKey;
    try {
      await run(key);
      results.push({ attempt: name, signer: who, expected, got: 'allow', detail: 'signed' });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      results.push({ attempt: name, signer: who, expected, got: 'deny', detail: `${err.status ?? ''} ${err.message ?? String(e)}`.trim().slice(0, 300) });
    }
    const r = results.at(-1)!;
    console.log(`${r.got === r.expected ? 'ok  ' : 'FAIL'} [${who}] ${name}: expected ${expected}, got ${r.got}${r.got === 'deny' ? ` (${r.detail.slice(0, 90)})` : ''}`);
  }

  const signTx = (t: ReturnType<typeof tx>) => (key: string) =>
    p.wallets().ethereum().signTransaction(wallet.id, { params: { transaction: t }, authorization_context: { authorization_private_keys: [key] } });
  const ex = (fn: string, args: unknown[]) => exchangeAbi.encodeFunctionData(fn, args);
  const erc = (fn: string, args: unknown[]) => erc20Abi.encodeFunctionData(fn, args);
  const nadBuy = (to: string) => routerAbi.encodeFunctionData('buyWithNative', [{ amountOutMin: 0n, token: MEME, to, deadline }]);
  const nadSell = (to: string) => routerAbi.encodeFunctionData('sellToNative', [{ amountIn: 10n ** 18n, amountOutMin: 0n, token: MEME, to, deadline }]);

  // ---- must be refused: over the cap -----------------------------------------
  await attempt('Perpl: deposit $60 (cap $50)', 'backend', 'deny', signTx(tx(exchange, ex('depositCollateral', [60n * unit]))));
  await attempt('Perpl: approve $51 AUSD to exchange (cap $50)', 'backend', 'deny', signTx(tx(collateralToken, erc('approve', [exchange, 51n * unit]))));
  await attempt('Nad.fun: buy with 0.06 MON (cap 0.05)', 'backend', 'deny', signTx(tx(NADFUN.router, nadBuy(wallet.address), ethers.parseEther('0.06'))));
  // ---- must be refused: withdrawal / moving funds out ------------------------
  await attempt('Perpl: withdrawCollateral $1', 'backend', 'deny', signTx(tx(exchange, ex('withdrawCollateral', [1n * unit]))));
  await attempt('Perpl: withdrawCollateral $0', 'backend', 'deny', signTx(tx(exchange, ex('withdrawCollateral', [0n]))));
  await attempt('AUSD transfer to an outside address', 'backend', 'deny', signTx(tx(collateralToken, erc('transfer', [stranger, 1n * unit]))));
  await attempt('AUSD approve to an outside address', 'backend', 'deny', signTx(tx(collateralToken, erc('approve', [stranger, 1n * unit]))));
  await attempt('send 1 MON to an outside address', 'backend', 'deny', signTx(tx(stranger, '0x', ethers.parseEther('1'))));
  await attempt('Nad.fun: buy with tokens delivered to a stranger', 'backend', 'deny', signTx(tx(NADFUN.router, nadBuy(stranger), ethers.parseEther('0.01'))));
  await attempt('Nad.fun: sell with MON proceeds to a stranger', 'backend', 'deny', signTx(tx(NADFUN.router, nadSell(stranger))));
  await attempt('meme token transfer to an outside address', 'backend', 'deny', signTx(tx(MEME, erc('transfer', [stranger, 10n ** 18n]))));
  await attempt('meme token approve to an outside address', 'backend', 'deny', signTx(tx(MEME, erc('approve', [stranger, 10n ** 18n]))));
  await attempt('Perpl deposit with MON value attached', 'backend', 'deny', signTx(tx(exchange, ex('depositCollateral', [10n * unit]), 1n)));
  // ---- Kuru Flow (AUSD <-> MON for memes) --------------------------------------
  const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
  const MON = ethers.ZeroAddress;
  const kuruSwap = (sells: string, buys: string, amount: bigint, feeBps = 0n, refBps = 0n) =>
    flowAbi.encodeFunctionData('executeSwap', [[buys, 1n, sells, amount], [ethers.ZeroAddress, feeBps, ethers.ZeroAddress, refBps, false], '0x']);
  await attempt('Kuru: executeSwapWithReceiver (pay a stranger)', 'backend', 'deny', signTx(tx(KURU_FLOW_ROUTER, flowAbi.encodeFunctionData('executeSwapWithReceiver', [[MON, 1n, collateralToken, 10n * unit], [ethers.ZeroAddress, 0n, ethers.ZeroAddress, 0n, false], '0x', stranger]))));
  await attempt('Kuru: AUSD->MON with a 1% fee', 'backend', 'deny', signTx(tx(KURU_FLOW_ROUTER, kuruSwap(collateralToken, MON, 10n * unit, 100n))));
  await attempt('Kuru: AUSD->MON with a referrer fee', 'backend', 'deny', signTx(tx(KURU_FLOW_ROUTER, kuruSwap(collateralToken, MON, 10n * unit, 0n, 50n))));
  await attempt('Kuru: AUSD->MON $60 (cap $50)', 'backend', 'deny', signTx(tx(KURU_FLOW_ROUTER, kuruSwap(collateralToken, MON, 60n * unit))));
  await attempt('Kuru: AUSD->USDC (not a meme leg)', 'backend', 'deny', signTx(tx(KURU_FLOW_ROUTER, kuruSwap(collateralToken, USDC, 10n * unit))));
  await attempt('Kuru: MON->AUSD 0.6 MON (cap 0.5)', 'backend', 'deny', signTx(tx(KURU_FLOW_ROUTER, kuruSwap(MON, collateralToken, ethers.parseEther('0.6')), ethers.parseEther('0.6'))));
  await attempt('Kuru: approve $51 AUSD (cap $50)', 'backend', 'deny', signTx(tx(collateralToken, erc('approve', [KURU_FLOW_ROUTER, 51n * unit]))));

  // ---- must be refused: things only the member does, once, in the browser ----
  await attempt('Perpl: createAccount', 'backend', 'deny', signTx(tx(exchange, ex('createAccount', [10n * unit]))));
  await attempt('Perpl: allowOrderForwarding(true)', 'backend', 'deny', signTx(tx(exchange, ex('allowOrderForwarding', [true]))));
  await attempt('Perpl: allowOrderForwarding(false)', 'backend', 'deny', signTx(tx(exchange, ex('allowOrderForwarding', [false]))));
  const td = await (
    await fetch(`${env.perplApiUrl}/v1/api-key/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain_id: env.chainId, address: wallet.address, public_key: '0x' + '22'.repeat(32), scope_mask: 2, label: 'e2e' }),
    })
  ).json();
  await attempt('sign a real Perpl api-key enrollment (mint itself a trading key)', 'backend', 'deny', (key) =>
    p.wallets().ethereum().signTypedData(wallet.id, {
      params: { typed_data: { domain: td.typed_data.domain, primary_type: td.typed_data.primaryType, types: td.typed_data.types, message: td.typed_data.message } as never },
      authorization_context: { authorization_private_keys: [key] },
    }),
  );

  // ---- must be allowed (positive controls) -----------------------------------
  await attempt('Perpl: deposit $40', 'backend', 'allow', signTx(tx(exchange, ex('depositCollateral', [40n * unit]))));
  await attempt('Perpl: approve $50 AUSD to exchange', 'backend', 'allow', signTx(tx(collateralToken, erc('approve', [exchange, 50n * unit]))));
  await attempt('Nad.fun: buy with 0.05 MON, tokens to member', 'backend', 'allow', signTx(tx(NADFUN.router, nadBuy(wallet.address), MAX_BUY)));
  await attempt('Nad.fun: sell, proceeds to member', 'backend', 'allow', signTx(tx(NADFUN.router, nadSell(wallet.address))));
  await attempt('meme token approve to the Nad.fun router', 'backend', 'allow', signTx(tx(MEME, erc('approve', [NADFUN.router, 10n ** 18n]))));
  await attempt('Kuru: approve $50 AUSD', 'backend', 'allow', signTx(tx(collateralToken, erc('approve', [KURU_FLOW_ROUTER, 50n * unit]))));
  await attempt('Kuru: AUSD->MON $50, no fees', 'backend', 'allow', signTx(tx(KURU_FLOW_ROUTER, kuruSwap(collateralToken, MON, 50n * unit))));
  await attempt('Kuru: MON->AUSD 0.5 MON, no fees', 'backend', 'allow', signTx(tx(KURU_FLOW_ROUTER, kuruSwap(MON, collateralToken, MAX_SELL), MAX_SELL)));

  // The owner isn't bound by the backend's policy.
  await attempt('member (owner) withdraws from Perpl', 'member', 'allow', signTx(tx(exchange, ex('withdrawCollateral', [1n * unit]))));

  evidence.results = results;
  const wrong = results.filter((r) => r.got !== r.expected);
  if (wrong.length) throw new Error(`GATE FAILED: ${wrong.map((w) => `${w.attempt} (expected ${w.expected}, got ${w.got})`).join('; ')}`);
  console.log(`\nGATE OK: ${results.filter((r) => r.expected === 'deny').length} backend attempts refused by Privy's policy engine, ${results.filter((r) => r.expected === 'allow').length} allowed`);
  evidence.result = 'pass';
} catch (e) {
  evidence.result = 'fail';
  evidence.error = String(e);
  evidence.results = results;
  console.error(e);
  process.exitCode = 1;
} finally {
  mkdirSync('data/evidence', { recursive: true });
  const file = `data/evidence/phase3-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log('evidence ->', file);
}
