import { decodeFunctionData, getAddress, isAddress, parseAbi } from 'viem';
import type { SignatureRequest } from './contracts';

// Predictions run on the member's own Polymarket account, and every step is
// signed by their own wallet. Most of those signatures move no money anywhere:
// signing in to Polymarket, letting Polymarket's contracts use the account,
// and a bet the member just placed. Those are signed without a wallet pop-up,
// so setting up and betting is one tap. Anything else (moving dollars out,
// authorizing a trading key, an unknown contract) still asks, as before.
//
// Checked here, in the browser, from the request itself: a backend can't
// widen it.

// Polymarket's protocol contracts on Polygon (from @polymarket/client's
// production config).
const POLYMARKET = new Set([
  '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', // pUSD (collateral)
  '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045', // conditional tokens
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296', // neg-risk adapter
  '0xAdA100Db00Ca00073811820692005400218FcE1f', // collateral adapter
  '0xadA2005600Dec949baf300f4C6120000bDB6eAab', // neg-risk collateral adapter
  '0xE111180000d2663C0091e4f400237545B87B996B', // exchange
  '0xe2222d279d744050d28e00520010520000310F59', // neg-risk exchange
  '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa', // exchange v3
  '0x12121212006e4CD160D18e3f00711DA5c3372600', // router
  '0x1000008dD9001B968442c1000017eaE6E0dA00Ba', // binary module
  '0x200000900045e3B6259600682756002200028933', // neg-risk module
  '0x30000034706c7d8e12009dab006be20000c031a8', // combinatorial module
  '0x006F54F7f9A22e0000CC2AB60031000000ae9fEF', // position manager
  '0xa1200000d0002264C9a1698e001292D00E1b00af', // auto-redeem operator
].map(a => getAddress(a)));
const EXCHANGES = new Set([
  '0xE111180000d2663C0091e4f400237545B87B996B',
  '0xe2222d279d744050d28e00520010520000310F59',
  '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa',
].map(a => getAddress(a)));
const POLYGON = 137;

const APPROVALS = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
]);

const known = (value: unknown, set: Set<string>) => typeof value === 'string' && isAddress(value) && set.has(getAddress(value));

// One call in a Deposit Wallet batch: only an approval of a Polymarket
// contract, made on a Polymarket contract, sending nothing.
function approvalOnly(call: unknown): boolean {
  if (!call || typeof call !== 'object') return false;
  const { target, data, value } = call as { target?: unknown; data?: unknown; value?: unknown };
  if (String(value ?? '0') !== '0' || !known(target, POLYMARKET) || typeof data !== 'string' || !data.startsWith('0x')) return false;
  try {
    const decoded = decodeFunctionData({ abi: APPROVALS, data: data as `0x${string}` });
    return known(decoded.args[0], POLYMARKET);
  } catch { return false; }
}

export function signsQuietly(request: SignatureRequest): boolean {
  const td = request.kind === 'typedData' ? request.typedData : null;
  if (!td) return false;
  const domain = td.domain;
  // Signing in to Polymarket (an API login, moves nothing).
  if (td.primaryType === 'ClobAuth' && domain.name === 'ClobAuthDomain') return true;
  if (Number(domain.chainId) !== POLYGON) return false;
  // A bet (or a sale) on Polymarket's exchange, placed by the member just now.
  if (td.primaryType === 'Order') return known(domain.verifyingContract, EXCHANGES);
  // Turning trading on: approvals of Polymarket's own contracts, nothing else.
  if (td.primaryType === 'Batch' && domain.name === 'DepositWallet') {
    const calls = td.message.calls;
    return Array.isArray(calls) && calls.length > 0 && calls.every(approvalOnly);
  }
  return false;
}
