import { ethers } from 'ethers';
import { getExchangeInfo } from '../perpl/context.js';
import { rpc, type WalletSigner } from './signer.js';

// Perpl Exchange + collateral token, the on-chain half of the account lifecycle.
// ABI fragments are from PerplFoundation/delegated-account interfaces/IExchange.sol.
export const exchangeAbi = new ethers.Interface([
  'function createAccount(uint256 amountCNS) returns (uint256 accountId)',
  'function depositCollateral(uint256 amountCNS)',
  'function withdrawCollateral(uint256 amountCNS)',
  'function allowOrderForwarding(bool allow)',
  'function getAccountByAddr(address accountAddress) view returns ((uint256 accountId, uint256 balanceCNS, uint256 lockedBalanceCNS, uint8 frozen, address accountAddr, (uint256 bank1, uint256 bank2, uint256 bank3, uint256 bank4) positions))',
  'event AccountCreated(address account, uint256 id)',
  'event OrderForwardingUpdated(uint256 accountId, bool allowed)',
]);

export const erc20Abi = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export interface OnChainAccount {
  accountId: bigint;
  balance: bigint;
  locked: bigint;
}

// getAccountByAddr reverts when the address has no account, so a revert here
// means "no account", not an RPC failure.
export async function getOnChainAccount(owner: string): Promise<OnChainAccount | null> {
  const { exchange } = await getExchangeInfo();
  const c = new ethers.Contract(exchange, exchangeAbi, rpc());
  try {
    const info = await c.getFunction('getAccountByAddr')(owner);
    if (info.accountId === 0n) return null;
    return { accountId: info.accountId, balance: info.balanceCNS, locked: info.lockedBalanceCNS };
  } catch (e) {
    if ((e as { code?: string }).code === 'CALL_EXCEPTION') return null;
    throw e;
  }
}

export async function collateralBalance(owner: string): Promise<bigint> {
  const { collateralToken } = await getExchangeInfo();
  const t = new ethers.Contract(collateralToken, erc20Abi, rpc());
  return t.getFunction('balanceOf')(owner);
}

async function ensureAllowance(signer: WalletSigner, amount: bigint): Promise<string | null> {
  const { exchange, collateralToken } = await getExchangeInfo();
  const t = new ethers.Contract(collateralToken, erc20Abi, rpc());
  const current: bigint = await t.getFunction('allowance')(signer.address, exchange);
  if (current >= amount) return null;
  // Approve exactly what's being deposited, never unlimited.
  return signer.sendTransaction({ to: collateralToken, data: erc20Abi.encodeFunctionData('approve', [exchange, amount]) });
}

export async function createAccount(signer: WalletSigner, amount: bigint): Promise<{ approveTx: string | null; createTx: string }> {
  const { exchange, minAccountOpen } = await getExchangeInfo();
  if (amount < minAccountOpen) throw new Error(`createAccount needs >= ${minAccountOpen} raw collateral, got ${amount}`);
  const approveTx = await ensureAllowance(signer, amount);
  const createTx = await signer.sendTransaction({ to: exchange, data: exchangeAbi.encodeFunctionData('createAccount', [amount]) });
  return { approveTx, createTx };
}

export async function depositCollateral(signer: WalletSigner, amount: bigint): Promise<{ approveTx: string | null; depositTx: string }> {
  const { exchange, minDeposit } = await getExchangeInfo();
  if (amount < minDeposit) throw new Error(`deposit needs >= ${minDeposit} raw collateral, got ${amount}`);
  const approveTx = await ensureAllowance(signer, amount);
  const depositTx = await signer.sendTransaction({ to: exchange, data: exchangeAbi.encodeFunctionData('depositCollateral', [amount]) });
  return { approveTx, depositTx };
}

export async function allowOrderForwarding(signer: WalletSigner, allow = true): Promise<string> {
  const { exchange } = await getExchangeInfo();
  return signer.sendTransaction({ to: exchange, data: exchangeAbi.encodeFunctionData('allowOrderForwarding', [allow]) });
}
