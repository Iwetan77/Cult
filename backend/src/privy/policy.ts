import { ethers } from 'ethers';
import { PrivyClient } from '@privy-io/node';
import { env, required } from '../config/env.js';
import { rpc, type Eip712TypedData, type TxRequest, type WalletSigner } from '../chain/signer.js';

// What the backend may ever do with a member's Privy wallet, enforced by
// Privy's policy engine, not by our code. The backend is added to each
// member's embedded wallet as an *additional signer* whose override policy is
// this. Privy denies anything no ALLOW rule matches, so it can't:
//   - withdraw from Perpl (withdrawCollateral has no ALLOW; explicit DENY too)
//   - move AUSD anywhere except an approve to the Perpl exchange
//   - send native MON (value must be 0)
//   - touch any contract other than the Perpl exchange and AUSD
//   - deposit/approve more than `maxDepositRaw` in one tx
//   - enroll a builder-fee-bearing Perpl key (builderId must be "0")
//
// The member's own wallet (the owner) is unaffected. They keep full control.
// Perpl orders themselves are signed with the Perpl API key, not this wallet,
// so the per-trade cap lives in mirror/sizing.ts (see CONTRACTS.md, decision 5).

const exchangeAbi = [
  { type: 'function', name: 'createAccount', stateMutability: 'nonpayable', inputs: [{ name: 'amountCNS', type: 'uint256' }], outputs: [{ name: 'accountId', type: 'uint256' }] },
  { type: 'function', name: 'depositCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'amountCNS', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdrawCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'amountCNS', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'allowOrderForwarding', stateMutability: 'nonpayable', inputs: [{ name: 'allow', type: 'bool' }], outputs: [] },
] as const;

const erc20ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const perplEnrollTypedData = {
  primary_type: 'PerplRegisterApiKey',
  types: {
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
};

export interface PolicyScope {
  exchange: string;
  collateralToken: string;
  chainId: number;
  maxDepositRaw: bigint; // per-tx ceiling on AUSD approve / createAccount / deposit
}

export function buildBackendPolicy(s: PolicyScope, name = 'cult-backend-perpl-only') {
  const exchange = s.exchange.toLowerCase();
  const ausd = s.collateralToken.toLowerCase();
  const max = s.maxDepositRaw.toString();
  const baseTx = (to: string) => [
    { field_source: 'ethereum_transaction' as const, field: 'to' as const, operator: 'eq' as const, value: to },
    { field_source: 'ethereum_transaction' as const, field: 'chain_id' as const, operator: 'eq' as const, value: String(s.chainId) },
    { field_source: 'ethereum_transaction' as const, field: 'value' as const, operator: 'eq' as const, value: '0' },
  ];
  const calldata = (field: string, operator: 'eq' | 'lte', value: string, abi: unknown) => ({
    field_source: 'ethereum_calldata' as const,
    field,
    abi: abi as never,
    operator,
    value,
  });

  // Same conditions for sign and send: we sign via Privy and broadcast through
  // our own RPC, but a send must be held to the identical scope.
  const txRules = (['eth_signTransaction', 'eth_sendTransaction'] as const).flatMap((method) => [
    {
      name: `${method}: never withdraw from Perpl`,
      method,
      action: 'DENY' as const,
      conditions: [
        { field_source: 'ethereum_transaction' as const, field: 'to' as const, operator: 'eq' as const, value: exchange },
        calldata('withdrawCollateral.amountCNS', 'lte', ethers.MaxUint256.toString(), exchangeAbi),
      ],
    },
    {
      name: `${method}: approve AUSD to Perpl, capped`,
      method,
      action: 'ALLOW' as const,
      conditions: [...baseTx(ausd), calldata('approve.spender', 'eq', exchange, erc20ApproveAbi), calldata('approve.amount', 'lte', max, erc20ApproveAbi)],
    },
    {
      name: `${method}: open Perpl account, capped`,
      method,
      action: 'ALLOW' as const,
      conditions: [...baseTx(exchange), calldata('createAccount.amountCNS', 'lte', max, exchangeAbi)],
    },
    {
      name: `${method}: deposit to Perpl, capped`,
      method,
      action: 'ALLOW' as const,
      conditions: [...baseTx(exchange), calldata('depositCollateral.amountCNS', 'lte', max, exchangeAbi)],
    },
    {
      name: `${method}: enable Perpl order forwarding`,
      method,
      action: 'ALLOW' as const,
      conditions: [...baseTx(exchange), calldata('allowOrderForwarding.allow', 'eq', 'true', exchangeAbi)],
    },
  ]);

  return {
    name,
    version: '1.0' as const,
    chain_type: 'ethereum' as const,
    rules: [
      ...txRules,
      {
        name: 'sign Perpl api-key enrollment, no builder fees',
        method: 'eth_signTypedData_v4' as const,
        action: 'ALLOW' as const,
        conditions: [
          { field_source: 'ethereum_typed_data_message' as const, field: 'builderId', typed_data: perplEnrollTypedData, operator: 'eq' as const, value: '0' },
          {
            field_source: 'ethereum_typed_data_message' as const,
            field: 'maxBuilderFeePer100K',
            typed_data: perplEnrollTypedData,
            operator: 'eq' as const,
            value: '0',
          },
        ],
      },
    ],
  };
}

let client: PrivyClient | undefined;
export function privy(): PrivyClient {
  client ??= new PrivyClient({ appId: required('PRIVY_APP_ID'), appSecret: required('PRIVY_APP_SECRET') });
  return client;
}

// WalletSigner backed by a Privy wallet, acting as the backend's authorization
// key. Every request is checked by Privy against the signer's policy before
// Privy produces a signature. We then broadcast via our RPC (Alchemy).
export class PrivyPolicySigner implements WalletSigner {
  constructor(
    readonly walletId: string,
    readonly address: string,
    private readonly authKey = required('PRIVY_BACKEND_AUTH_KEY'),
  ) {}

  async signTransactionOnly(tx: TxRequest): Promise<string> {
    const p = rpc();
    const [nonce, fee, gas] = await Promise.all([
      p.getTransactionCount(this.address, 'pending'),
      p.getFeeData(),
      p.estimateGas({ from: this.address, to: tx.to, data: tx.data, value: tx.value ?? 0n }).catch(() => 300_000n),
    ]);
    const res = await privy()
      .wallets()
      .ethereum()
      .signTransaction(this.walletId, {
        params: {
          transaction: {
            to: tx.to,
            data: tx.data as `0x${string}`,
            value: ethers.toQuantity(tx.value ?? 0n),
            chain_id: ethers.toQuantity(env.chainId),
            nonce: ethers.toQuantity(nonce),
            gas_limit: ethers.toQuantity((gas * 12n) / 10n),
            max_fee_per_gas: ethers.toQuantity(fee.maxFeePerGas ?? fee.gasPrice ?? 0n),
            max_priority_fee_per_gas: ethers.toQuantity(fee.maxPriorityFeePerGas ?? 0n),
            type: 2,
          },
        },
        authorization_context: { authorization_private_keys: [this.authKey] },
      });
    return res.signed_transaction;
  }

  async sendTransaction(tx: TxRequest): Promise<string> {
    const signed = await this.signTransactionOnly(tx);
    const sent = await rpc().broadcastTransaction(signed);
    const rcpt = await sent.wait();
    if (!rcpt || rcpt.status !== 1) throw new Error(`tx reverted: ${sent.hash}`);
    return sent.hash;
  }

  async signTypedData(td: Eip712TypedData): Promise<string> {
    const res = await privy()
      .wallets()
      .ethereum()
      .signTypedData(this.walletId, {
        params: { typed_data: { domain: td.domain, types: td.types, primary_type: td.primaryType, message: td.message } as never },
        authorization_context: { authorization_private_keys: [this.authKey] },
      });
    return res.signature;
  }
}

// The policy the frontend attaches (via Privy's addSigners) when it adds the
// backend signer to a member's wallet. One per member: the cap follows the
// largest maxUsdPerTrade they've agreed to across their clans, and a fresh
// policy is created if that grows. Privy rejects anything above it.
export async function memberSignerGrant(userId: string, maxUsdPerTrade: number) {
  const { members } = await import('../store/members.js');
  const { getExchangeInfo } = await import('../perpl/context.js');
  const { exchange, collateralToken, collateralDecimals } = await getExchangeInfo();
  const capRaw = BigInt(Math.ceil(maxUsdPerTrade)) * 10n ** BigInt(collateralDecimals);
  const existing = members.privyPolicy(userId);
  let policyId = existing?.id;
  if (!existing || existing.capRaw < capRaw) {
    const created = await privy()
      .policies()
      .create(buildBackendPolicy({ exchange, collateralToken, chainId: env.chainId, maxDepositRaw: capRaw }, `cult-member-${userId.slice(-12)}-${Date.now()}`));
    policyId = created.id;
    members.setPrivyPolicy(userId, created.id, capRaw);
  }
  return { signerId: required('PRIVY_BACKEND_KEY_QUORUM_ID'), policyIds: [policyId!], capUsd: Number(capRaw) / 10 ** collateralDecimals };
}
