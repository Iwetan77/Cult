import { ethers } from 'ethers';
import { env } from '../config/env.js';

// Everything the member's wallet has to sign goes through this interface, so the
// lifecycle code doesn't care whether it's a Privy embedded wallet (prod) or a
// raw testnet key (scripts). The Privy implementation lives in src/privy.
export interface Eip712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface TxRequest {
  to: string;
  data: string;
  value?: bigint;
}

export interface SendOptions {
  // Called with the tx hash after signing and before broadcast, so callers can
  // record "this tx is ours" before any event for it can be observed on-chain.
  onHash?: (hash: string) => void;
}

export interface WalletSigner {
  readonly address: string;
  signTypedData(td: Eip712TypedData): Promise<string>;
  // Returns the tx hash once the tx is mined with status 1; throws on revert.
  sendTransaction(tx: TxRequest, opts?: SendOptions): Promise<string>;
}

// Broadcast an already-signed tx and wait for success.
export async function broadcastSigned(signed: string, opts: SendOptions = {}): Promise<string> {
  const hash = ethers.Transaction.from(signed).hash!;
  opts.onHash?.(hash);
  const sent = await rpc().broadcastTransaction(signed);
  const rcpt = await sent.wait();
  if (!rcpt || rcpt.status !== 1) throw new Error(`tx reverted: ${hash}`);
  return hash;
}

let provider: ethers.JsonRpcProvider | undefined;
export function rpc(): ethers.JsonRpcProvider {
  provider ??= new ethers.JsonRpcProvider(env.rpcUrl, env.chainId, { staticNetwork: true });
  return provider;
}

export class LocalKeySigner implements WalletSigner {
  readonly wallet: ethers.Wallet;
  constructor(privateKey: string) {
    this.wallet = new ethers.Wallet(privateKey, rpc());
  }
  get address() {
    return this.wallet.address;
  }
  async signTypedData(td: Eip712TypedData) {
    const { EIP712Domain: _omit, ...types } = td.types;
    return this.wallet.signTypedData(td.domain as ethers.TypedDataDomain, types, td.message);
  }
  async sendTransaction(tx: TxRequest, opts: SendOptions = {}) {
    const populated = await this.wallet.populateTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
    return broadcastSigned(await this.wallet.signTransaction(populated), opts);
  }
}
