import { ethers } from 'ethers';
import { signerFor } from '../accounts/signers.js';
import { rpc } from '../chain/signer.js';
import { buy, quoteSell, sell, tokenAbi, tokenBalance } from '../nadfun/trading.js';
import { monPriceAusd } from '../prices.js';
import { members } from '../store/members.js';
import type { CloseInput, Fill, Holding, OpenInput, VenueAdapter } from './types.js';

// Nad.fun: every buy/sell is a tx from the member's own wallet, signed by
// signerFor(userId), which in production is the Privy policy signer. Buys
// spend native MON; everything is reported back in AUSD at Perpl's MON mark.

// MON always kept back for gas, so a mirror can't leave a member unable to
// sell or to pay for their own next transaction.
export const GAS_RESERVE_WEI = ethers.parseEther(process.env.NADFUN_GAS_RESERVE_MON ?? '0.05');
const SLIPPAGE_BPS = Number(process.env.NADFUN_SLIPPAGE_BPS ?? 300);
const ONE = 10n ** 18n; // Nad.fun tokens are 18 decimals
const toNum = (wei: bigint) => Number(ethers.formatEther(wei));

const symbols = new Map<string, string>();
async function symbolOf(token: string) {
  const k = token.toLowerCase();
  if (!symbols.has(k)) {
    const s: string = await new ethers.Contract(token, tokenAbi, rpc()).getFunction('symbol')().catch(() => 'TOKEN');
    symbols.set(k, s);
  }
  return symbols.get(k)!;
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
    const monPx = await monPriceAusd();
    const monIn = ethers.parseEther((i.notionalAusd / monPx).toFixed(18));
    if (monIn <= 0n) throw new Error('buy rounds to 0 MON');
    const signer = signerFor(i.userId);
    const fill = await buy(signer, i.market, monIn, SLIPPAGE_BPS, (txHash) => i.onRef?.({ txHash, wallet: signer.address }));
    const tokens = toNum(fill.tokenAmount);
    const spentAusd = toNum(fill.monAmount) * monPx;
    return {
      venue: 'nadfun',
      market: i.market.toLowerCase(),
      side: 'buy',
      sizeRaw: fill.tokenAmount.toString(),
      size: tokens,
      priceAusd: tokens > 0 ? spentAusd / tokens : 0,
      notionalAusd: spentAusd,
      txHash: fill.txHash,
    };
  },

  async close(i: CloseInput): Promise<Fill> {
    const monPx = await monPriceAusd();
    const signer = signerFor(i.userId);
    const fill = await sell(signer, i.market, i.sizeRaw != null ? BigInt(i.sizeRaw) : undefined, SLIPPAGE_BPS, (txHash) =>
      i.onRef?.({ txHash, wallet: signer.address }),
    );
    const tokens = toNum(fill.tokenAmount);
    const gotAusd = toNum(fill.monAmount) * monPx;
    return {
      venue: 'nadfun',
      market: i.market.toLowerCase(),
      side: 'buy',
      sizeRaw: fill.tokenAmount.toString(),
      size: tokens,
      priceAusd: tokens > 0 ? gotAusd / tokens : 0,
      notionalAusd: gotAusd,
      txHash: fill.txHash,
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

  async freeBalanceAusd(userId: string): Promise<number> {
    const bal = await rpc().getBalance(walletOf(userId));
    const spendable = bal > GAS_RESERVE_WEI ? bal - GAS_RESERVE_WEI : 0n;
    return toNum(spendable) * (await monPriceAusd());
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
