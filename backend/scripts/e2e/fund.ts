import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { required } from '../../src/config/env.js';
import { collateralBalance, erc20Abi } from '../../src/chain/exchange.js';
import { LocalKeySigner, rpc } from '../../src/chain/signer.js';
import { getExchangeInfo } from '../../src/perpl/context.js';

// Test-only helpers: a throwaway testnet "funder" wallet seeds fresh wallets
// with MON (gas) and AUSD (collateral), so every e2e run starts from zero.

export const GAS_PER_WALLET = ethers.parseEther(process.env.E2E_GAS_MON ?? '0.3');

export function funder(): LocalKeySigner {
  return new LocalKeySigner(required('FUNDER_PRIVATE_KEY'));
}

export async function preflight(wallets: number, ausdPerWallet: bigint) {
  const f = funder();
  const [mon, ausd] = await Promise.all([rpc().getBalance(f.address), collateralBalance(f.address)]);
  const needMon = GAS_PER_WALLET * BigInt(wallets) + ethers.parseEther('0.05');
  const needAusd = ausdPerWallet * BigInt(wallets);
  console.log(`funder ${f.address}: ${ethers.formatEther(mon)} MON, ${Number(ausd) / 1e6} AUSD`);
  const short: string[] = [];
  if (mon < needMon) short.push(`${ethers.formatEther(needMon - mon)} more MON`);
  if (ausd < needAusd) short.push(`${Number(needAusd - ausd) / 1e6} more testnet AUSD`);
  if (short.length) {
    const { collateralToken } = await getExchangeInfo();
    throw new Error(`funder needs ${short.join(' and ')} (AUSD token ${collateralToken}) to run this with ${wallets} wallet(s)`);
  }
}

// Every throwaway key is saved (git-ignored) so leftover testnet funds can be
// swept back to the funder instead of stranded when a run ends.
const KEYS_FILE = 'data/e2e-wallets.jsonl';

export function newThrowaway(label: string): LocalKeySigner {
  const w = ethers.Wallet.createRandom();
  mkdirSync('data', { recursive: true });
  appendFileSync(KEYS_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey, label, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return new LocalKeySigner(w.privateKey);
}

export function savedThrowaways(): LocalKeySigner[] {
  if (!existsSync(KEYS_FILE)) return [];
  return readFileSync(KEYS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => new LocalKeySigner(JSON.parse(l).privateKey));
}

// Send a throwaway wallet's AUSD and spare MON back to the funder. Monad
// charges gas on the limit, so leave limit x max fee (x2 margin) behind.
export async function sweepBack(s: LocalKeySigner): Promise<{ mon: string; ausd: string }> {
  const f = funder();
  const out = { mon: '0', ausd: '0' };
  const { collateralToken } = await getExchangeInfo();
  const ausd = await collateralBalance(s.address);
  if (ausd > 0n) {
    await s.sendTransaction({ to: collateralToken, data: erc20Abi.encodeFunctionData('transfer', [f.address, ausd]) }).catch(() => undefined);
    out.ausd = ethers.formatUnits(ausd, 6);
  }
  const fee = await rpc().getFeeData();
  const reserve = 21_000n * (fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('200', 'gwei')) * 2n;
  const bal = await rpc().getBalance(s.address);
  if (bal > reserve * 2n) {
    const value = bal - reserve;
    await s.wallet.sendTransaction({ to: f.address, value, gasLimit: 21_000n }).then((t) => t.wait()).catch(() => undefined);
    out.mon = ethers.formatEther(value);
  }
  return out;
}

export async function freshFundedWallet(ausd: bigint): Promise<{ signer: LocalKeySigner; txs: string[] }> {
  const f = funder();
  const signer = newThrowaway('perpl-e2e');
  const w = signer.wallet;
  const { collateralToken } = await getExchangeInfo();
  const txs: string[] = [];
  txs.push(await f.sendTransaction({ to: w.address, data: '0x', value: GAS_PER_WALLET }));
  txs.push(await f.sendTransaction({ to: collateralToken, data: erc20Abi.encodeFunctionData('transfer', [w.address, ausd]) }));
  return { signer, txs };
}
