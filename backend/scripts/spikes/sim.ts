// Shared helpers for simulating mainnet txs with eth_call + state overrides,
// so swap routes can be proven against real liquidity without spending.
import { ethers } from 'ethers';

export const MAINNET = new ethers.JsonRpcProvider('https://rpc.monad.xyz', 143, { staticNetwork: true });
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
export const erc = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
export const coder = ethers.AbiCoder.defaultAbiCoder();

export async function rawCall(tx: object, overrides: object) {
  return MAINNET.send('eth_call', [tx, 'latest', overrides]);
}

// OpenZeppelin v5 upgradeable ERC20 keeps its mappings in an ERC-7201 namespace
// ("openzeppelin.storage.ERC20"): balances at base, allowances at base + 1.
const OZ_ERC20_BASE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const candidates = [...Array.from({ length: 60 }, (_, i) => BigInt(i)), OZ_ERC20_BASE];

// Find the mapping slot for balanceOf / allowance by writing a marker and reading it back.
export async function findSlots(token: string, who: string, spender: string) {
  const marker = ethers.toBeHex(123456789n, 32);
  let balSlot: bigint | undefined;
  for (const s of candidates) {
    if (balSlot !== undefined) break;
    const key = ethers.keccak256(coder.encode(['address', 'uint256'], [who, s]));
    const out = await rawCall({ to: token, data: erc.encodeFunctionData('balanceOf', [who]) }, { [token]: { stateDiff: { [key]: marker } } }).catch(() => '0x');
    if (out !== '0x' && BigInt(out) === 123456789n) balSlot = s;
  }
  let allowSlot: bigint | undefined;
  for (const base of candidates) {
    if (allowSlot !== undefined) break;
    const s = base === OZ_ERC20_BASE ? base + 1n : base;
    const inner = ethers.keccak256(coder.encode(['address', 'uint256'], [who, s]));
    const key = ethers.keccak256(coder.encode(['address', 'bytes32'], [spender, inner]));
    const out = await rawCall({ to: token, data: erc.encodeFunctionData('allowance', [who, spender]) }, { [token]: { stateDiff: { [key]: marker } } }).catch(() => '0x');
    if (out !== '0x' && BigInt(out) === 123456789n) allowSlot = s;
  }
  return { balSlot, allowSlot };
}

// Fallback for tokens with unusual storage: ask the node which storage keys
// balanceOf / allowance actually read, and override those keys directly.
export async function accessKeys(token: string, data: string): Promise<string[]> {
  const r = (await MAINNET.send('eth_createAccessList', [{ to: token, data }, 'latest'])) as { accessList: { address: string; storageKeys: string[] }[] };
  return r.accessList.flatMap((a) => a.storageKeys);
}
// Returns the key that drives the read, and the bit shift the token stores it
// at (AUSD, for one, keeps balances << 8 with flag bits underneath).
export async function keyThatControls(token: string, data: string, keys: string[]): Promise<{ key: string; shift: bigint } | undefined> {
  const marker = 987654321n << 16n;
  for (const k of keys) {
    const out = await rawCall({ to: token, data }, { [token]: { stateDiff: { [k]: ethers.toBeHex(marker, 32) } } }).catch(() => '0x');
    if (out === '0x') continue;
    const v = BigInt(out);
    for (let sh = 0n; sh <= 64n; sh++) if (v === marker >> sh) return { key: k, shift: sh };
  }
  return undefined;
}


// State overrides that give `who` `amount` of `token` and an allowance of `amount` to `spender`.
export async function erc20Overrides(token: string, who: string, spender: string, amount: bigint): Promise<Record<string, unknown> | null> {
  const { balSlot, allowSlot } = await findSlots(token, who, spender);
  let bal: { key: string; shift: bigint } | undefined;
  let allow: { key: string; shift: bigint } | undefined;
  if (balSlot !== undefined && allowSlot !== undefined) {
    bal = { key: ethers.keccak256(coder.encode(['address', 'uint256'], [who, balSlot])), shift: 0n };
    allow = { key: ethers.keccak256(coder.encode(['address', 'bytes32'], [spender, ethers.keccak256(coder.encode(['address', 'uint256'], [who, allowSlot]))])), shift: 0n };
  } else {
    const bData = erc.encodeFunctionData('balanceOf', [who]);
    const aData = erc.encodeFunctionData('allowance', [who, spender]);
    bal = await keyThatControls(token, bData, await accessKeys(token, bData));
    allow = await keyThatControls(token, aData, await accessKeys(token, aData));
  }
  if (!bal || !allow) return null;
  return { [token]: { stateDiff: { [bal.key]: ethers.toBeHex(amount << bal.shift, 32), [allow.key]: ethers.toBeHex(amount << allow.shift, 32) } } };
}
