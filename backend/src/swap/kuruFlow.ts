import { ethers } from 'ethers';
import { rpc, type WalletSigner } from '../chain/signer.js';
import { erc20Abi } from '../chain/exchange.js';

// Kuru Flow: Kuru's routing API over all Monad mainnet liquidity (Kuru books,
// AMMs, and pools like the ~$1.5M AUSD/USDC stable pool it routes through).
// It returns a ready-to-sign tx for the KuruFlowEntrypoint router.
//
// Nothing it returns is trusted blindly: every quote is decoded and checked
// before it can be signed (right router, executeSwap only, intent matches the
// request, zero fees). executeSwap always pays msg.sender; the variant that
// takes a receiver (executeSwapWithReceiver) is refused here and by the Privy
// policy, because signing it for a member would be a withdrawal.

export const KURU_FLOW_API = process.env.KURU_FLOW_API ?? 'https://ws.kuru.io';
export const KURU_FLOW_ROUTER = '0xb3e6778480b2E488385E8205eA05E20060B813cb'; // KuruFlowEntrypoint, Monad mainnet
export const NATIVE = ethers.ZeroAddress; // Kuru Flow's address for native MON

export const flowAbi = new ethers.Interface([
  'function executeSwap((address tokenUserBuys, uint256 minAmountUserBuys, address tokenUserSells, uint256 amountUserSells) swapIntent, (address feeCollectorAddress, uint256 feeBps, address referrerAddress, uint256 referrerFeeBps, bool isInTokenFee) feeCollection, bytes program) payable returns (uint256 amountOut)',
  'function executeSwapWithReceiver((address,uint256,address,uint256), (address,uint256,address,uint256,bool), bytes, address) payable returns (uint256)',
  'event KuruFlowSwap(address indexed user, address indexed referrer, address tokenIn, address tokenOut, bool isFeeInInput, uint256 amountIn, uint256 amountOut, uint256 referrerFeeBps, uint256 totalFeeBps)',
]);
export const EXECUTE_SWAP = flowAbi.getFunction('executeSwap')!.selector; // 0xce1e7030

export interface SwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  out: bigint; // expected
  minOut: bigint; // enforced on-chain
  tx: { to: string; data: string; value: bigint };
}

export class SwapUnavailable extends Error {}

// JWTs are per user address, 1 rps; cache until shortly before expiry.
const tokens = new Map<string, { token: string; exp: number }>();
async function jwt(user: string): Promise<string> {
  const k = user.toLowerCase();
  const hit = tokens.get(k);
  if (hit && hit.exp - 60 > Date.now() / 1000) return hit.token;
  const r = await fetch(`${KURU_FLOW_API}/api/generate-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_address: user }) });
  if (!r.ok) throw new SwapUnavailable(`kuru flow token ${r.status}`);
  const j = (await r.json()) as { token: string; expires_at: number };
  tokens.set(k, { token: j.token, exp: j.expires_at });
  return j.token;
}

// The quote must describe exactly the swap we asked for, via executeSwap on
// the known router, paying nobody but the caller. Throws otherwise.
export function checkQuoteTx(tx: { to: string; data: string; value: bigint }, want: { tokenIn: string; tokenOut: string; amountIn: bigint }) {
  if (tx.to.toLowerCase() !== KURU_FLOW_ROUTER.toLowerCase()) throw new Error(`kuru flow quote targets ${tx.to}, not the Kuru router`);
  if (!tx.data.startsWith(EXECUTE_SWAP)) throw new Error(`kuru flow quote is not executeSwap (selector ${tx.data.slice(0, 10)})`);
  const [intent, fee] = flowAbi.decodeFunctionData('executeSwap', tx.data) as unknown as [
    [string, bigint, string, bigint],
    [string, bigint, string, bigint, boolean],
  ];
  const [buys, , sells, amount] = intent;
  if (sells.toLowerCase() !== want.tokenIn.toLowerCase() || buys.toLowerCase() !== want.tokenOut.toLowerCase()) throw new Error('kuru flow quote swaps different tokens');
  if (amount !== want.amountIn) throw new Error(`kuru flow quote sells ${amount}, asked ${want.amountIn}`);
  if (fee[1] !== 0n || fee[3] !== 0n) throw new Error(`kuru flow quote carries fees (${fee[1]} / ${fee[3]} bps)`);
  const expectValue = want.tokenIn === NATIVE ? want.amountIn : 0n;
  if (tx.value !== expectValue) throw new Error(`kuru flow quote sends ${tx.value} native, expected ${expectValue}`);
}

export async function quoteSwap(user: string, tokenIn: string, tokenOut: string, amountIn: bigint, slippageBps = 50): Promise<SwapQuote> {
  if (amountIn <= 0n) throw new Error('swap amount must be > 0');
  const r = await fetch(`${KURU_FLOW_API}/api/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${await jwt(user)}` },
    body: JSON.stringify({ userAddress: user, tokenIn, tokenOut, amount: amountIn.toString(), slippageTolerance: slippageBps }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    status?: string;
    message?: string;
    output?: string;
    minOut?: string;
    transaction?: { to: string; calldata: string; value: string };
  };
  if (!r.ok || j.status !== 'success' || !j.transaction) throw new SwapUnavailable(`no Kuru route ${tokenIn} -> ${tokenOut}: ${j.message ?? r.status}`);
  const tx = { to: j.transaction.to, data: '0x' + j.transaction.calldata.replace(/^0x/, ''), value: BigInt(j.transaction.value || '0') };
  checkQuoteTx(tx, { tokenIn, tokenOut, amountIn });
  return { tokenIn, tokenOut, amountIn, out: BigInt(j.output ?? '0'), minOut: BigInt(j.minOut ?? '0'), tx };
}

export interface SwapFill {
  txHash: string;
  approveTx: string | null;
  amountIn: bigint;
  received: bigint; // from the router's own KuruFlowSwap event
}

// The router's event is the exact amount paid out. (Balance diffs lie for
// native MON on Monad, where gas is charged on the gas limit.)
async function receivedFromReceipt(txHash: string, user: string): Promise<bigint> {
  const rc = await rpc().getTransactionReceipt(txHash);
  for (const log of rc?.logs ?? []) {
    if (log.address.toLowerCase() !== KURU_FLOW_ROUTER.toLowerCase()) continue;
    const ev = flowAbi.parseLog(log);
    if (ev?.name === 'KuruFlowSwap' && (ev.args[0] as string).toLowerCase() === user.toLowerCase()) return ev.args[6] as bigint;
  }
  throw new Error(`KuruFlowSwap event not found in ${txHash}`);
}

// Quote, approve exactly what's sold if it's an ERC20, execute, and report
// what actually arrived. `onHash` fires before broadcast (engine tagging).
export async function swap(
  signer: WalletSigner,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  opts: { slippageBps?: number; onHash?: (h: string) => void } = {},
): Promise<SwapFill> {
  const q = await quoteSwap(signer.address, tokenIn, tokenOut, amountIn, opts.slippageBps);
  let approveTx: string | null = null;
  if (tokenIn !== NATIVE) {
    const t = new ethers.Contract(tokenIn, erc20Abi, rpc());
    if ((await t.getFunction('allowance')(signer.address, KURU_FLOW_ROUTER)) < amountIn) {
      approveTx = await signer.sendTransaction({ to: tokenIn, data: erc20Abi.encodeFunctionData('approve', [KURU_FLOW_ROUTER, amountIn]) });
    }
  }
  const txHash = await signer.sendTransaction(q.tx, { onHash: opts.onHash });
  return { txHash, approveTx, amountIn, received: await receivedFromReceipt(txHash, signer.address) };
}
