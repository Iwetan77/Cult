import { ethers } from 'ethers';
import { signerFor } from '../accounts/signers.js';
import { rpc } from '../chain/signer.js';
import { env, numEnv } from '../config/env.js';
import { erc20Abi } from '../chain/exchange.js';
import { buy, quoteSell, sell, tokenAbi, tokenBalance } from '../nadfun/trading.js';
import { getExchangeInfo } from '../perpl/context.js';
import { monPriceAusd } from '../prices.js';
import { NATIVE, swap } from '../swap/kuruFlow.js';
import { members } from '../store/members.js';
import { FundsError } from '../funding/errors.js';
import type { CloseInput, Fill, Holding, OpenInput, VenueAdapter } from './types.js';

// Nad.fun: every buy/sell is a tx from the member's own wallet, signed by
// signerFor(userId), which in production is the Privy policy signer.
//
// Memes are priced in MON, but members hold dollars (AUSD). With pay-with
// 'ausd' (the default on mainnet) a buy is: swap exactly the dollar amount of
// the member's wallet AUSD to MON on Kuru Flow, then buy with what arrived. A
// sell is: sell to MON, then swap exactly those proceeds back to AUSD. The
// gas reserve is never touched. With 'mon' (testnet, where Kuru Flow doesn't
// exist) buys spend the wallet's MON directly.
export type PayWith = 'ausd' | 'mon';
export function nadPaysWith(): PayWith {
  const v = process.env.NADFUN_PAY_WITH;
  if (v === 'ausd' || v === 'mon') return v;
  return env.chainId === 143 ? 'ausd' : 'mon';
}

// MON always kept back for gas, so a mirror can't leave a member unable to
// sell or to pay for their own next transaction. Sized from real testnet
// runs: Monad charges the whole gas limit, a Nad.fun sell is ~0.055 MON, an
// approve ~0.006, and paying in dollars adds a Kuru swap back. 0.25 covers a
// full exit with margin (about $0.007 at current MON prices).
export const GAS_RESERVE_WEI = ethers.parseEther(String(numEnv('NADFUN_GAS_RESERVE_MON', 0.25)));
const SLIPPAGE_BPS = numEnv('NADFUN_SLIPPAGE_BPS', 300);
const ONE = 10n ** 18n; // Nad.fun tokens are 18 decimals
const toNum = (wei: bigint) => Number(ethers.formatEther(wei));
const toAusdRaw = (usd: number) => ethers.parseUnits(usd.toFixed(6), 6);
const ausdToken = async () => (await getExchangeInfo()).collateralToken; // same AUSD Perpl settles in

const symbols = new Map<string, string>();
async function symbolOf(token: string) {
  const k = token.toLowerCase();
  if (!symbols.has(k)) {
    const s: string = await new ethers.Contract(token, tokenAbi, rpc()).getFunction('symbol')().catch(() => 'TOKEN');
    symbols.set(k, s);
  }
  return symbols.get(k)!;
}

// The two things a meme buy can be paid from, in $: wallet AUSD (only where
// memes are paid in dollars) and MON above the gas reserve.
async function memePockets(userId: string, monPx: number): Promise<{ ausdUsd: number; monUsd: number }> {
  const wallet = walletOf(userId);
  const [ausdRaw, bal] = await Promise.all([
    nadPaysWith() === 'ausd' ? (new ethers.Contract(await ausdToken(), erc20Abi, rpc()).getFunction('balanceOf')(wallet) as Promise<bigint>) : Promise.resolve(0n),
    rpc().getBalance(wallet),
  ]);
  const spareMon = bal > GAS_RESERVE_WEI ? bal - GAS_RESERVE_WEI : 0n;
  return { ausdUsd: Number(ethers.formatUnits(ausdRaw, 6)), monUsd: toNum(spareMon) * monPx };
}

// Dollars first, when they cover the buy; else MON.
async function payWithFor(userId: string, usd: number, monPx: number): Promise<PayWith> {
  const { ausdUsd, monUsd } = await memePockets(userId, monPx);
  if (ausdUsd >= usd) return 'ausd';
  if (monUsd >= usd) return 'mon';
  const have = Math.max(ausdUsd, monUsd);
  throw new FundsError(`Not enough funds for a $${usd.toFixed(2)} buy: you have about $${have.toFixed(2)} to spend (keeping ${ethers.formatEther(GAS_RESERVE_WEI)} MON for fees)`);
}

// Which pocket memes are bought from for this member right now: the bigger one.
export async function memesPayWithFor(userId: string): Promise<PayWith> {
  if (nadPaysWith() === 'mon') return 'mon';
  const { ausdUsd, monUsd } = await memePockets(userId, await monPriceAusd().catch(() => 0));
  return ausdUsd >= monUsd ? 'ausd' : 'mon';
}

function walletOf(userId: string) {
  const w = members.get(userId)?.wallet;
  if (!w) throw new Error(`unknown member ${userId}`);
  return w;
}

export const nadfun: VenueAdapter = {
  venue: 'nadfun',

  async open(i: OpenInput): Promise<Fill> {
    if (i.side !== 'buy') throw new Error('nad.fun only buys (spot)');
    const signer = signerFor(i.userId);
    const tag = (txHash: string) => i.onRef?.({ txHash, wallet: signer.address });
    const monPx = await monPriceAusd();
    let monIn: bigint;
    let spentAusd: number;
    const extraTxs: string[] = [];
    // Paid in dollars when there are enough of them (deposited USDC is turned
    // into AUSD first if that's what's missing); otherwise straight from MON,
    // so a member who only deposited MON can still buy.
    if (nadPaysWith() === 'ausd' && (await memePockets(i.userId, monPx)).ausdUsd < i.notionalAusd) {
      const { convertUsdcNow } = await import('../funding/usdc.js');
      await convertUsdcNow(i.userId);
    }
    const payWith = await payWithFor(i.userId, i.notionalAusd, monPx);
    if (payWith === 'ausd') {
      const ausdIn = toAusdRaw(i.notionalAusd);
      if (ausdIn <= 0n) throw new Error('buy rounds to $0');
      const sw = await swap(signer, await ausdToken(), NATIVE, ausdIn, { onHash: tag });
      if (sw.approveTx) extraTxs.push(sw.approveTx);
      extraTxs.push(sw.txHash);
      monIn = sw.received;
      spentAusd = Number(ethers.formatUnits(ausdIn, 6));
    } else {
      monIn = ethers.parseEther((i.notionalAusd / monPx).toFixed(18));
      if (monIn <= 0n) throw new Error('buy rounds to 0 MON');
      spentAusd = 0; // filled in from the fill below
    }
    let fill;
    try {
      fill = await buy(signer, i.market, monIn, SLIPPAGE_BPS, tag);
    } catch (e) {
      if (extraTxs.length) throw new Error(`swapped to MON (${extraTxs.at(-1)}) but the meme buy failed; the MON is still in the member's wallet: ${String(e)}`);
      throw e;
    }
    if (payWith === 'mon') spentAusd = toNum(fill.monAmount) * monPx;
    const tokens = toNum(fill.tokenAmount);
    return {
      venue: 'nadfun',
      market: i.market.toLowerCase(),
      side: 'buy',
      sizeRaw: fill.tokenAmount.toString(),
      size: tokens,
      priceAusd: tokens > 0 ? spentAusd / tokens : 0,
      notionalAusd: spentAusd,
      txHash: fill.txHash,
      extraTxs,
    };
  },

  async close(i: CloseInput): Promise<Fill> {
    const signer = signerFor(i.userId);
    const tag = (txHash: string) => i.onRef?.({ txHash, wallet: signer.address });
    const fill = await sell(signer, i.market, i.sizeRaw != null ? BigInt(i.sizeRaw) : undefined, SLIPPAGE_BPS, tag);
    const tokens = toNum(fill.tokenAmount);
    const extraTxs: string[] = fill.approveTx ? [fill.approveTx] : [];
    let gotAusd: number;
    if (nadPaysWith() === 'ausd') {
      // Swap back exactly the sale's MON; the gas reserve stays put.
      try {
        const sw = await swap(signer, NATIVE, await ausdToken(), fill.monAmount, { onHash: tag });
        extraTxs.push(sw.txHash);
        gotAusd = Number(ethers.formatUnits(sw.received, 6));
      } catch (e) {
        throw new Error(`sold (${fill.txHash}) but swapping the MON back to dollars failed; the MON is in the member's wallet: ${String(e)}`);
      }
    } else {
      gotAusd = toNum(fill.monAmount) * (await monPriceAusd());
    }
    return {
      venue: 'nadfun',
      market: i.market.toLowerCase(),
      side: 'buy',
      sizeRaw: fill.tokenAmount.toString(),
      size: tokens,
      priceAusd: tokens > 0 ? gotAusd / tokens : 0,
      notionalAusd: gotAusd,
      txHash: fill.txHash,
      extraTxs,
    };
  },

  // Nad.fun has no per-wallet positions API, so callers pass the tokens they
  // care about (the ones this member traded through Cult). Value is what
  // selling the whole balance would return right now, not a mid price.
  async holdings(userId: string, markets: string[] = []): Promise<Holding[]> {
    const wallet = walletOf(userId);
    const monPx = await monPriceAusd();
    const out: Holding[] = [];
    for (const token of new Set(markets.map((m) => m.toLowerCase()))) {
      const bal = await tokenBalance(token, wallet);
      if (bal === 0n) continue;
      const monOut = await quoteSell(token, bal).catch(() => 0n);
      const size = toNum(bal);
      const valueAusd = toNum(monOut) * monPx;
      out.push({
        venue: 'nadfun',
        market: token,
        symbol: await symbolOf(token),
        side: 'buy',
        sizeRaw: bal.toString(),
        size,
        entryPriceAusd: null,
        markPriceAusd: size > 0 ? valueAusd / size : 0,
        valueAusd,
        pnlAusd: null,
        leverage: 1,
      });
    }
    return out;
  },

  // What a meme mirror may spend, in dollars: the bigger of wallet AUSD
  // (pay-with ausd) and MON above the gas reserve. A buy draws on one of them.
  async freeBalanceAusd(userId: string): Promise<number> {
    const { ausdUsd, monUsd } = await memePockets(userId, await monPriceAusd());
    return Math.max(ausdUsd, monUsd);
  },

  // AUSD per whole token, from what selling one token returns right now.
  async markPriceAusd(market: string) {
    const monOut = await quoteSell(market, ONE).catch(() => 0n);
    return toNum(monOut) * (await monPriceAusd());
  },

  async maxLeverage() {
    return 1;
  },
};
