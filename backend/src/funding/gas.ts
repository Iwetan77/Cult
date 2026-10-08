import { ethers } from 'ethers';
import { numEnv, strEnv } from '../config/env.js';
import { erc20Abi } from '../chain/exchange.js';
import { LocalKeySigner, rpc } from '../chain/signer.js';
import { usdcAddress } from '../chain/tokens.js';
import { getExchangeInfo } from '../perpl/context.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { GAS_RESERVE_WEI } from '../venues/nadfun.js';

// Every transaction on Monad pays its fee in MON. Members deposit dollars
// (AUSD, USDC), so a new wallet has none and its first transaction fails
// ("insufficient balance"). Cult's gas wallet (GAS_FUNDER_PRIVATE_KEY) tops a
// member up with a little MON when they're below the gas reserve: before any
// transaction the backend signs for them, before the app sends one, and as
// soon as /v1/me sees dollars in a wallet with no MON.
//
// Only members holding at least $1, at most 3 top-ups per member and
// GAS_DRIPS_PER_DAY overall per day, so it can't be farmed. Off when the key
// isn't set. Copies, top-ups and every other path stay exactly as they are:
// the member's own wallet still sends and pays, it just has the MON to.

const DAY = 86_400_000;
const PER_MEMBER_PER_DAY = 3;
const dripWei = () => ethers.parseEther(String(numEnv('GAS_DRIP_MON', 0.5)));
const perDay = () => numEnv('GAS_DRIPS_PER_DAY', 300);
const funderKey = () => strEnv('GAS_FUNDER_PRIVATE_KEY', '');
export const gasToppingOn = () => !!funderKey();

export type GasResult = { mon: number; topped: boolean; reason?: 'off' | 'not_member' | 'no_funds' | 'limit' };

// What a top-up needs from the outside world (swapped in tests).
export interface GasDeps {
  balance(wallet: string): Promise<bigint>;
  dollars(wallet: string): Promise<number>; // AUSD + USDC in the wallet
  send(to: string, wei: bigint): Promise<string>; // from the gas wallet; resolves when mined
}

async function dollarsIn(wallet: string): Promise<number> {
  const { collateralToken, collateralDecimals } = await getExchangeInfo();
  const usdc = usdcAddress();
  const read = (token: string) => new ethers.Contract(token, erc20Abi, rpc()).getFunction('balanceOf')(wallet) as Promise<bigint>;
  const [ausd, u] = await Promise.all([read(collateralToken), usdc ? read(usdc) : Promise.resolve(0n)]);
  return Number(ethers.formatUnits(ausd, collateralDecimals)) + Number(ethers.formatUnits(u, 6));
}

// One send at a time from the gas wallet (its nonce).
let lane: Promise<unknown> = Promise.resolve();
let funder: LocalKeySigner | null = null;
const defaultDeps: GasDeps = {
  balance: (wallet) => rpc().getBalance(wallet),
  dollars: dollarsIn,
  send: (to, wei) => {
    const run = lane.then(() => (funder ??= new LocalKeySigner(funderKey())).sendTransaction({ to, data: '0x', value: wei }));
    lane = run.catch(() => undefined);
    return run;
  },
};

const dripsSince = (since: number, wallet?: string) =>
  (wallet
    ? getDb().prepare('SELECT count(*) AS n FROM gas_drips WHERE wallet = ? AND created_at > ?').get(wallet, since)
    : getDb().prepare('SELECT count(*) AS n FROM gas_drips WHERE created_at > ?').get(since)) as { n: number };

const inflight = new Map<string, Promise<GasResult>>();

export function ensureGas(walletIn: string, deps: GasDeps = defaultDeps, now = Date.now()): Promise<GasResult> {
  const wallet = walletIn.toLowerCase();
  const running = inflight.get(wallet);
  if (running) return running;
  const run = (async (): Promise<GasResult> => {
    const bal = await deps.balance(wallet);
    const mon = Number(ethers.formatEther(bal));
    if (bal >= GAS_RESERVE_WEI) return { mon, topped: false };
    if (deps === defaultDeps && !gasToppingOn()) return { mon, topped: false, reason: 'off' };
    if (!members.byWallet(wallet)) return { mon, topped: false, reason: 'not_member' };
    if (dripsSince(now - DAY, wallet).n >= PER_MEMBER_PER_DAY || dripsSince(now - DAY).n >= perDay()) return { mon, topped: false, reason: 'limit' };
    if ((await deps.dollars(wallet)) < 1) return { mon, topped: false, reason: 'no_funds' };
    const wei = dripWei();
    const hash = await deps.send(wallet, wei);
    getDb().prepare('INSERT INTO gas_drips (wallet, amount_wei, tx_hash, created_at) VALUES (?, ?, ?, ?)').run(wallet, wei.toString(), hash, now);
    console.log(`[gas] topped up ${wallet.slice(0, 8)}… with ${ethers.formatEther(wei)} MON (${hash})`);
    return { mon: Number(ethers.formatEther(bal + wei)), topped: true };
  })().finally(() => inflight.delete(wallet));
  inflight.set(wallet, run);
  return run;
}
