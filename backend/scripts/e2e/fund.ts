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

export async function freshFundedWallet(ausd: bigint): Promise<{ signer: LocalKeySigner; txs: string[] }> {
  const f = funder();
  const w = ethers.Wallet.createRandom();
  const { collateralToken } = await getExchangeInfo();
  const txs: string[] = [];
  txs.push(await f.sendTransaction({ to: w.address, data: '0x', value: GAS_PER_WALLET }));
  txs.push(await f.sendTransaction({ to: collateralToken, data: erc20Abi.encodeFunctionData('transfer', [w.address, ausd]) }));
  return { signer: new LocalKeySigner(w.privateKey), txs };
}
