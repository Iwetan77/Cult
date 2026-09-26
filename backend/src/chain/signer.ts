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

export interface WalletSigner {
  readonly address: string;
  signTypedData(td: Eip712TypedData): Promise<string>;
  // Returns the tx hash once the tx is mined with status 1; throws on revert.
  sendTransaction(tx: TxRequest): Promise<string>;
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
  async sendTransaction(tx: TxRequest) {
    const sent = await this.wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
    const rcpt = await sent.wait();
    if (!rcpt || rcpt.status !== 1) throw new Error(`tx reverted: ${sent.hash}`);
    return sent.hash;
  }
}
