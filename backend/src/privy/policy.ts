import { ethers } from 'ethers';
import { PrivyClient } from '@privy-io/node';
import { env, required } from '../config/env.js';
import { rpc, type Eip712TypedData, type TxRequest, type WalletSigner } from '../chain/signer.js';

// What the backend may ever do with a member's Privy wallet, enforced by
// Privy's policy engine, not by our code. The backend is an *additional
// signer* on each member's embedded wallet under this override policy. Privy
// denies anything no ALLOW rule matches.
//
// Backend MAY (all capped, all chain-pinned, all with no native value unless stated):
//   - approve AUSD to the Perpl exchange, <= maxDepositRaw
//   - depositCollateral into Perpl, <= maxDepositRaw
//   - Nad.fun buyWithNative: router only, MON value <= maxBuyWei, tokens to the member
//   - Nad.fun sellToNative: router only, MON proceeds to the member
//   - approve a token to the Nad.fun router (needed before a sell)
// Backend may NOT:
//   - withdrawCollateral (explicit DENY on top of default deny)
//   - transfer AUSD / tokens / MON anywhere
//   - route Nad.fun buy/sell output to anyone but the member
//   - createAccount, allowOrderForwarding, or sign Perpl key enrollments. The member's
//     own wallet does those once, in the browser, during setup. So the backend can
//     never mint itself a new Perpl trading key.
//
// Rule formats here are the ones verified against Privy's API (see scripts/e2e/phase3.ts):
// tuple params use `fn.params.field`, and bool calldata params can't be matched.
// Perpl orders are signed with the Perpl API key, not this wallet, so the Perpl
// per-trade cap lives in mirror/sizing.ts (CONTRACTS.md, decision 5).

const perplAbi = [
  { type: 'function', name: 'depositCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'amountCNS', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdrawCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'amountCNS', type: 'uint256' }], outputs: [] },
] as const;

const approveAbi = [
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

const nadAbi = [
  {
    type: 'function',
    name: 'buyWithNative',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sellToNative',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface PolicyScope {
  member: string; // the member's wallet; buy/sell output must go here
  chainId: number;
  perplExchange: string;
  perplCollateral: string;
  maxDepositRaw: bigint; // per-tx ceiling on AUSD approve / deposit into Perpl
  nadRouter: string;
  maxBuyWei: bigint; // per-tx ceiling on MON spent on one Nad.fun buy
}

type Cond = Record<string, unknown>;
const tx = (field: 'to' | 'value' | 'chain_id', operator: 'eq' | 'lte', value: string): Cond => ({
  field_source: 'ethereum_transaction',
  field,
  operator,
  value,
});
const call = (field: string, operator: 'eq' | 'lte', value: string, abi: unknown): Cond => ({
  field_source: 'ethereum_calldata',
  field,
  abi,
  operator,
  value,
});

export function buildBackendPolicy(s: PolicyScope, name = 'cult-backend') {
  const me = s.member.toLowerCase();
  const exchange = s.perplExchange.toLowerCase();
  const ausd = s.perplCollateral.toLowerCase();
  const router = s.nadRouter.toLowerCase();
  const chain = tx('chain_id', 'eq', String(s.chainId));
  const noValue = tx('value', 'eq', '0');

  // Same rules for sign and send: we sign via Privy and broadcast through our
  // own RPC, but a direct send must be held to the identical scope.
  const rules = (['eth_signTransaction', 'eth_sendTransaction'] as const).flatMap((method) => {
    const m = method === 'eth_signTransaction' ? 'sign' : 'send'; // rule names must be < 50 chars
    return [
    {
      name: `${m}: never withdraw from Perpl`,
      method,
      action: 'DENY' as const,
      conditions: [tx('to', 'eq', exchange), call('withdrawCollateral.amountCNS', 'lte', ethers.MaxUint256.toString(), perplAbi)],
    },
    {
      name: `${m}: approve AUSD to Perpl, capped`,
      method,
      action: 'ALLOW' as const,
      conditions: [tx('to', 'eq', ausd), chain, noValue, call('approve.spender', 'eq', exchange, approveAbi), call('approve.amount', 'lte', s.maxDepositRaw.toString(), approveAbi)],
    },
    {
      name: `${m}: deposit into Perpl, capped`,
      method,
      action: 'ALLOW' as const,
      conditions: [tx('to', 'eq', exchange), chain, noValue, call('depositCollateral.amountCNS', 'lte', s.maxDepositRaw.toString(), perplAbi)],
    },
    {
      name: `${m}: Nad.fun buy, capped, to member`,
      method,
      action: 'ALLOW' as const,
      conditions: [tx('to', 'eq', router), chain, tx('value', 'lte', s.maxBuyWei.toString()), call('buyWithNative.params.to', 'eq', me, nadAbi)],
    },
    {
      name: `${m}: Nad.fun sell, to member`,
      method,
      action: 'ALLOW' as const,
      conditions: [tx('to', 'eq', router), chain, noValue, call('sellToNative.params.to', 'eq', me, nadAbi)],
    },
    {
      name: `${m}: approve token to Nad.fun router`,
      method,
      action: 'ALLOW' as const,
      conditions: [chain, noValue, call('approve.spender', 'eq', router, approveAbi)],
    },
    ];
  });

  return { name, version: '1.0' as const, chain_type: 'ethereum' as const, rules };
}

let client: PrivyClient | undefined;
export function privy(): PrivyClient {
  client ??= new PrivyClient({ appId: required('PRIVY_APP_ID'), appSecret: required('PRIVY_APP_SECRET') });
  return client;
}

// WalletSigner backed by a member's Privy wallet, acting as the backend's
// authorization key. Privy checks every request against the policy before it
// produces a signature; we then broadcast via our own RPC (Alchemy).
export class PrivyPolicySigner implements WalletSigner {
  constructor(
    readonly walletId: string,
    readonly address: string,
    private readonly authKey = required('PRIVY_BACKEND_AUTH_KEY'),
  ) {}

  async signTransactionOnly(t: TxRequest): Promise<string> {
    const p = rpc();
    const [nonce, fee, gas] = await Promise.all([
      p.getTransactionCount(this.address, 'pending'),
      p.getFeeData(),
      p.estimateGas({ from: this.address, to: t.to, data: t.data, value: t.value ?? 0n }).catch(() => 400_000n),
    ]);
    const res = await privy()
      .wallets()
      .ethereum()
      .signTransaction(this.walletId, {
        params: {
          transaction: {
            to: t.to,
            data: t.data as `0x${string}`,
            value: ethers.toQuantity(t.value ?? 0n),
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

  async sendTransaction(t: TxRequest): Promise<string> {
    const signed = await this.signTransactionOnly(t);
    const sent = await rpc().broadcastTransaction(signed);
    const rcpt = await sent.wait();
    if (!rcpt || rcpt.status !== 1) throw new Error(`tx reverted: ${sent.hash}`);
    return sent.hash;
  }

  // By design: the backend never signs typed data for a member. Perpl key
  // enrollment is signed by the member's own wallet in the browser.
  async signTypedData(_td: Eip712TypedData): Promise<string> {
    throw new Error('backend signer does not sign typed data; the member signs enrollment in the client');
  }
}

// MON/AUSD from Perpl's own MON perp mark price, so the Nad.fun cap follows
// the member's AUSD cap without adding a price oracle to the stack.
export async function monPriceAusd(): Promise<number> {
  const { getMarketBySymbol, getTicker, scale } = await import('../perpl/context.js');
  const m = await getMarketBySymbol('MON');
  const { d } = await getTicker();
  const px = scale.unprice(d[String(m.id)]?.mrk ?? 0, m);
  if (!(px > 0)) throw new Error('no MON mark price from Perpl');
  return px;
}

// The grant the frontend passes to Privy's addSigners() for a member. One
// policy per member (it pins their wallet and their cap). A fresh policy is
// created whenever the cap goes up.
export async function memberSignerGrant(userId: string, wallet: string, maxUsdPerTrade: number) {
  const { members } = await import('../store/members.js');
  const { getExchangeInfo } = await import('../perpl/context.js');
  const { NADFUN } = await import('../nadfun/constants.js');
  const { exchange, collateralToken, collateralDecimals } = await getExchangeInfo();
  const capRaw = BigInt(Math.ceil(maxUsdPerTrade)) * 10n ** BigInt(collateralDecimals);
  const monPx = await monPriceAusd();
  const maxBuyWei = ethers.parseEther((maxUsdPerTrade / monPx).toFixed(18));

  const existing = members.privyPolicy(userId);
  let policyId = existing?.id;
  if (!existing || existing.capRaw < capRaw) {
    const created = await privy()
      .policies()
      .create(
        buildBackendPolicy(
          { member: wallet, chainId: env.chainId, perplExchange: exchange, perplCollateral: collateralToken, maxDepositRaw: capRaw, nadRouter: NADFUN.router, maxBuyWei },
          `cult-member-${wallet.slice(2, 10)}-${Date.now()}`,
        ) as never,
      );
    policyId = created.id;
    members.setPrivyPolicy(userId, created.id, capRaw);
  }
  return {
    signerId: required('PRIVY_BACKEND_KEY_QUORUM_ID'),
    policyIds: [policyId!],
    capAusd: Number(capRaw) / 10 ** collateralDecimals,
    maxBuyMon: Number(ethers.formatEther(maxBuyWei)),
    monPriceAusd: monPx,
  };
}
