import { Hono } from 'hono';
import { ethers } from 'ethers';
import { z } from 'zod';
import { env } from '../config/env.js';
import { erc20Abi } from '../chain/exchange.js';
import { rpc } from '../chain/signer.js';
import { usdcAddress } from '../chain/tokens.js';
import type { WalletAction } from '../accounts/client-flow.js';
import { getExchangeInfo } from '../perpl/context.js';
import { members } from '../store/members.js';
import { pins } from '../store/pins.js';
import { GAS_RESERVE_WEI } from '../venues/nadfun.js';
import { IntentsError, intentsEnabled } from '../intents/aurora.js';
import { UpstreamError } from '../http.js';
import { chainOptions, depositQuote, recentSwaps, swapStatus, tellDeposit, withdrawPlan } from '../intents/crosschain.js';

// /v1/intents: money in from / out to other chains (Aurora Intents), and
// /v1/wallet/withdraw: plain sends on Monad. See CONTRACTS.md.
// Withdrawals come back as wallet actions the member signs in the browser:
// the backend can never move a member's funds itself.

type Vars = { Variables: { userId: string; wallet: string } };

const onError = (err: Error, c: { json: (b: object, s: number) => Response }) => {
  if (err instanceof IntentsError) return c.json({ message: err.message }, err.status);
  if (err instanceof z.ZodError) return c.json({ message: 'invalid request', issues: err.issues }, 400);
  if (err instanceof UpstreamError || /fetch failed|timeout/i.test(err.message) || err.name === 'TimeoutError' || /SwapUnavailable/.test(err.name)) {
    console.warn('[intents] upstream unavailable:', err.message);
    return c.json({ message: 'a service this needs is unreachable right now, retry shortly' }, 503);
  }
  console.error('[intents]', err);
  return c.json({ message: 'internal error' }, 500);
};

export function intentRoutes() {
  const r = new Hono<Vars>();
  r.onError(onError as never);

  r.get('/chains', async (c) => {
    if (!intentsEnabled() || env.chainId !== 143) return c.json({ enabled: false, chains: [] });
    return c.json({ enabled: true, chains: await chainOptions() });
  });

  r.post('/deposit', async (c) => {
    const b = z.object({ originAsset: z.string().min(3).max(200), amount: z.union([z.string(), z.number()]).transform(String), refundTo: z.string().max(128).optional() }).parse(await c.req.json());
    return c.json(await depositQuote(c.get('userId'), b));
  });

  r.post('/withdraw', async (c) => {
    const b = z.object({ destinationAsset: z.string().min(3).max(200), amountUsd: z.number().positive(), recipient: z.string().min(1).max(128), pin: z.string().optional() }).parse(await c.req.json());
    pins.check(c.get('userId'), b.pin); // money leaving Cult: the member's PIN
    return c.json(await withdrawPlan(c.get('userId'), { destinationAsset: b.destinationAsset, amountUsd: b.amountUsd, recipient: b.recipient }));
  });

  r.get('/status/:depositAddress', async (c) => c.json(await swapStatus(c.get('userId'), c.req.param('depositAddress'))));

  r.post('/submit', async (c) => {
    const b = z.object({ depositAddress: z.string().min(3), txHash: z.string().min(10).max(200) }).parse(await c.req.json());
    await tellDeposit(c.get('userId'), b.depositAddress, b.txHash);
    return c.body(null, 204);
  });

  r.get('/swaps', (c) => c.json({ swaps: recentSwaps(c.get('userId')) }));

  return r;
}

export class WithdrawError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

// A send on Monad, for the member to sign: MON (keeping the gas reserve),
// dollars (AUSD) or USDC, to any address but their own.
export async function withdrawActions(userId: string, b: { symbol: 'MON' | 'AUSD' | 'USDC'; amount: number; to: string }) {
  const m = members.get(userId)!;
  if (!ethers.isAddress(b.to)) throw new WithdrawError(400, 'Enter a valid Monad address (0x followed by 40 characters).');
  if (b.to.toLowerCase() === m.wallet) throw new WithdrawError(400, 'That’s your own Cult wallet.');
  if (!(b.amount > 0)) throw new WithdrawError(400, 'Enter an amount above zero.');
  const to = ethers.getAddress(b.to);
  let action: WalletAction;
  if (b.symbol === 'MON') {
    const wei = ethers.parseEther(b.amount.toFixed(18));
    const bal = await rpc().getBalance(m.wallet);
    if (wei > bal - GAS_RESERVE_WEI) throw new WithdrawError(409, `You can send up to ${ethers.formatEther(bal > GAS_RESERVE_WEI ? bal - GAS_RESERVE_WEI : 0n)} MON (a little stays for fees).`);
    action = { to, data: '0x', value: ethers.toQuantity(wei), chainId: env.chainId, label: `Send ${b.amount} MON` };
  } else {
    const token = b.symbol === 'USDC' ? usdcAddress() : (await getExchangeInfo()).collateralToken;
    if (!token) throw new WithdrawError(409, 'USDC is on Monad mainnet only.');
    const decimals = b.symbol === 'USDC' ? 6 : (await getExchangeInfo()).collateralDecimals;
    const raw = ethers.parseUnits(b.amount.toFixed(decimals), decimals);
    const bal: bigint = await new ethers.Contract(token, erc20Abi, rpc()).getFunction('balanceOf')(m.wallet);
    if (raw > bal) throw new WithdrawError(409, `You have ${ethers.formatUnits(bal, decimals)} ${b.symbol === 'AUSD' ? 'dollars' : 'USDC'} in your wallet.`);
    action = { to: token, data: erc20Abi.encodeFunctionData('transfer', [to, raw]), chainId: env.chainId, label: `Send ${b.symbol === 'AUSD' ? `$${b.amount}` : `${b.amount} USDC`}` };
  }
  return { symbol: b.symbol, amount: b.amount, to, actions: [action] };
}
