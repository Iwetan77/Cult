// Phase 3 gate: prove Privy's policy engine, not our code, stops the backend
// from exceeding the cap or withdrawing.
//
// Setup (all real Privy API calls):
//   - "member" P-256 key = stand-in for the user owner of the wallet
//   - "backend" P-256 key, registered as a 1-of-1 key quorum
//   - the Perpl-only policy from src/privy/policy.ts, cap = $50
//   - a wallet owned by the member key, with the backend quorum as an
//     additional signer under that override policy
// Then the backend key tries things it must not be able to do, and a couple
// it should (so a deny-all policy can't pass this). Signing only, nothing is
// broadcast, so this needs no testnet funds.
import { mkdirSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { generateP256KeyPair } from '@privy-io/node';
import { env } from '../../src/config/env.js';
import { erc20Abi, exchangeAbi } from '../../src/chain/exchange.js';
import { getExchangeInfo } from '../../src/perpl/context.js';
import { buildBackendPolicy, privy } from '../../src/privy/policy.js';

const CAP_USD = 50n;
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };
const results: { attempt: string; signer: string; expected: 'allow' | 'deny'; got: 'allow' | 'deny'; detail: string }[] = [];

try {
  const { exchange, collateralToken, collateralDecimals } = await getExchangeInfo();
  const unit = 10n ** BigInt(collateralDecimals);
  const cap = CAP_USD * unit;
  const p = privy();

  const member = await generateP256KeyPair();
  const backend = await generateP256KeyPair();
  const quorum = await p.keyQuorums().create({ public_keys: [backend.publicKey], authorization_threshold: 1, display_name: 'cult-backend-e2e' });
  const policy = await p.policies().create(buildBackendPolicy({ exchange, collateralToken, chainId: env.chainId, maxDepositRaw: cap }, `cult-e2e-${Date.now()}`));
  const wallet = await p.wallets().create({
    chain_type: 'ethereum',
    owner: { public_key: member.publicKey },
    additional_signers: [{ signer_id: quorum.id, override_policy_ids: [policy.id] }],
  });
  console.log('wallet', wallet.address, 'policy', policy.id, 'backend quorum', quorum.id);
  evidence.setup = { walletId: wallet.id, address: wallet.address, policyId: policy.id, keyQuorumId: quorum.id, capRaw: cap.toString() };

  const attacker = ethers.Wallet.createRandom().address;
  const tx = (to: string, data: string, value = 0n) => ({
    to,
    data: data as `0x${string}`,
    value: ethers.toQuantity(value),
    chain_id: ethers.toQuantity(env.chainId),
    nonce: '0x0',
    gas_limit: ethers.toQuantity(300_000),
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
    console.log(`${r.got === r.expected ? 'ok  ' : 'FAIL'} [${who}] ${name}: expected ${expected}, got ${r.got}${r.got === 'deny' ? ` (${r.detail})` : ''}`);
  }

  const signTx = (t: ReturnType<typeof tx>) => (key: string) =>
    p.wallets().ethereum().signTransaction(wallet.id, { params: { transaction: t }, authorization_context: { authorization_private_keys: [key] } });

  const ex = (fn: string, args: unknown[]) => exchangeAbi.encodeFunctionData(fn, args);
  const erc = (fn: string, args: unknown[]) => erc20Abi.encodeFunctionData(fn, args);

  // Must be refused.
  await attempt('deposit $60 into Perpl (cap $50)', 'backend', 'deny', signTx(tx(exchange, ex('depositCollateral', [60n * unit]))));
  await attempt('createAccount with $500 (cap $50)', 'backend', 'deny', signTx(tx(exchange, ex('createAccount', [500n * unit]))));
  await attempt('approve $51 of AUSD to Perpl (cap $50)', 'backend', 'deny', signTx(tx(collateralToken, erc('approve', [exchange, 51n * unit]))));
  await attempt('withdrawCollateral $1 from Perpl', 'backend', 'deny', signTx(tx(exchange, ex('withdrawCollateral', [1n * unit]))));
  await attempt('withdrawCollateral $0', 'backend', 'deny', signTx(tx(exchange, ex('withdrawCollateral', [0n]))));
  await attempt('transfer AUSD to an outside address', 'backend', 'deny', signTx(tx(collateralToken, erc('transfer', [attacker, 1n * unit]))));
  await attempt('approve AUSD to an outside address', 'backend', 'deny', signTx(tx(collateralToken, erc('approve', [attacker, 1n * unit]))));
  await attempt('send 1 MON to an outside address', 'backend', 'deny', signTx(tx(attacker, '0x', ethers.parseEther('1'))));
  await attempt('deposit with MON value attached', 'backend', 'deny', signTx(tx(exchange, ex('depositCollateral', [10n * unit]), 1n)));
  await attempt('disable order forwarding', 'backend', 'deny', signTx(tx(exchange, ex('allowOrderForwarding', [false]))));

  // Must be allowed (positive controls).
  await attempt('deposit $40 into Perpl', 'backend', 'allow', signTx(tx(exchange, ex('depositCollateral', [40n * unit]))));
  await attempt('approve $50 of AUSD to Perpl', 'backend', 'allow', signTx(tx(collateralToken, erc('approve', [exchange, 50n * unit]))));
  await attempt('enable order forwarding', 'backend', 'allow', signTx(tx(exchange, ex('allowOrderForwarding', [true]))));

  // Perpl api-key enrollment: fee-free key allowed, builder-fee key refused.
  const signEnroll = (builderId: string, fee: string) => (key: string) =>
    p.wallets().ethereum().signTypedData(wallet.id, {
      params: {
        typed_data: {
          domain: { name: 'perpl.xyz', version: '1', chainId: env.chainId, verifyingContract: ethers.ZeroAddress },
          primary_type: 'PerplRegisterApiKey',
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
            PerplRegisterApiKey: [
              { name: 'signer', type: 'address' },
              { name: 'statement', type: 'string' },
              { name: 'publicKey', type: 'string' },
              { name: 'scope', type: 'string' },
              { name: 'label', type: 'string' },
              { name: 'expiresAt', type: 'string' },
              { name: 'ipCidrs', type: 'string' },
              { name: 'origin', type: 'string' },
              { name: 'builderId', type: 'string' },
              { name: 'maxBuilderFeePer100K', type: 'string' },
              { name: 'time', type: 'uint64' },
            ],
          },
          message: {
            signer: wallet.address,
            statement: 'I authorize the creation of Perpl API key with the specified scope and parameters',
            publicKey: 'e2e',
            scope: '3',
            label: 'cult',
            expiresAt: '0',
            ipCidrs: '',
            origin: '',
            builderId,
            maxBuilderFeePer100K: fee,
            time: Date.now(),
          },
        } as never,
      },
      authorization_context: { authorization_private_keys: [key] },
    });
  await attempt('sign Perpl key enrollment, no builder fee', 'backend', 'allow', signEnroll('0', '0'));
  await attempt('sign Perpl key enrollment with a 0.1% builder fee', 'backend', 'deny', signEnroll('7', '100'));

  // The owner is not bound by the backend's policy. The restriction is on the backend only.
  await attempt('member (owner) withdraws from Perpl', 'member', 'allow', signTx(tx(exchange, ex('withdrawCollateral', [1n * unit]))));

  evidence.results = results;
  const wrong = results.filter((r) => r.got !== r.expected);
  if (wrong.length) throw new Error(`GATE FAILED: ${wrong.map((w) => `${w.attempt} (expected ${w.expected}, got ${w.got})`).join('; ')}`);
  console.log(`\nGATE OK: ${results.filter((r) => r.expected === 'deny').length} backend attempts refused by Privy's policy engine`);
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
