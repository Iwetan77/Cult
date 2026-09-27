// Kuru Flow on Monad mainnet, proven without spending anything:
//   1. get a live quote from Kuru's routing API
//   2. run it through checkQuoteTx (router, executeSwap only, intent, zero fees)
//   3. execute that exact calldata as an eth_call on mainnet, from a throwaway
//      address given a balance (and allowance) via state overrides, so the
//      real route runs against real liquidity and must return >= minOut.
// ERC20 balance/allowance slots are found by probing, not assumed.
import { ethers } from 'ethers';
import { checkQuoteTx, flowAbi, KURU_FLOW_ROUTER, NATIVE, quoteSwap } from '../../src/swap/kuruFlow.js';

const MAINNET = new ethers.JsonRpcProvider('https://rpc.monad.xyz', 143, { staticNetwork: true });
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const erc = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const coder = ethers.AbiCoder.defaultAbiCoder();

async function rawCall(tx: object, overrides: object) {
  return MAINNET.send('eth_call', [tx, 'latest', overrides]);
}

// OpenZeppelin v5 upgradeable ERC20 keeps its mappings in an ERC-7201 namespace
// ("openzeppelin.storage.ERC20"): balances at base, allowances at base + 1.
const OZ_ERC20_BASE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const candidates = [...Array.from({ length: 60 }, (_, i) => BigInt(i)), OZ_ERC20_BASE];

// Find the mapping slot for balanceOf / allowance by writing a marker and reading it back.
async function findSlots(token: string, who: string, spender: string) {
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
async function accessKeys(token: string, data: string): Promise<string[]> {
  const r = (await MAINNET.send('eth_createAccessList', [{ to: token, data }, 'latest'])) as { accessList: { address: string; storageKeys: string[] }[] };
  return r.accessList.flatMap((a) => a.storageKeys);
}
// Returns the key that drives the read, and the bit shift the token stores it
// at (AUSD, for one, keeps balances << 8 with flag bits underneath).
async function keyThatControls(token: string, data: string, keys: string[]): Promise<{ key: string; shift: bigint } | undefined> {
  const marker = 987654321n << 16n;
  for (const k of keys) {
    const out = await rawCall({ to: token, data }, { [token]: { stateDiff: { [k]: ethers.toBeHex(marker, 32) } } }).catch(() => '0x');
    if (out === '0x') continue;
    const v = BigInt(out);
    for (let sh = 0n; sh <= 64n; sh++) if (v === marker >> sh) return { key: k, shift: sh };
  }
  return undefined;
}

async function simulate(label: string, tokenIn: string, tokenOut: string, amountIn: bigint, fmtIn: (x: bigint) => string, fmtOut: (x: bigint) => string) {
  const who = ethers.Wallet.createRandom().address;
  const q = await quoteSwap(who, tokenIn, tokenOut, amountIn);
  checkQuoteTx(q.tx, { tokenIn, tokenOut, amountIn }); // (quoteSwap already did; explicit for the record)
  const overrides: Record<string, unknown> = { [who]: { balance: ethers.toQuantity(ethers.parseEther('1000000')) } };
  if (tokenIn !== NATIVE) {
    const { balSlot, allowSlot } = await findSlots(tokenIn, who, KURU_FLOW_ROUTER);
    let bal: { key: string; shift: bigint } | undefined;
    let allow: { key: string; shift: bigint } | undefined;
    if (balSlot !== undefined && allowSlot !== undefined) {
      bal = { key: ethers.keccak256(coder.encode(['address', 'uint256'], [who, balSlot])), shift: 0n };
      allow = { key: ethers.keccak256(coder.encode(['address', 'bytes32'], [KURU_FLOW_ROUTER, ethers.keccak256(coder.encode(['address', 'uint256'], [who, allowSlot]))])), shift: 0n };
    } else {
      const bData = erc.encodeFunctionData('balanceOf', [who]);
      const aData = erc.encodeFunctionData('allowance', [who, KURU_FLOW_ROUTER]);
      bal = await keyThatControls(tokenIn, bData, await accessKeys(tokenIn, bData));
      allow = await keyThatControls(tokenIn, aData, await accessKeys(tokenIn, aData));
    }
    if (!bal || !allow) {
      console.log(`${label}: quote OK (out ${fmtOut(q.out)}, min ${fmtOut(q.minOut)}), but couldn't locate ${tokenIn} storage to simulate`);
      return;
    }
    overrides[tokenIn] = { stateDiff: { [bal.key]: ethers.toBeHex(amountIn << bal.shift, 32), [allow.key]: ethers.toBeHex(amountIn << allow.shift, 32) } };
  }
  const out = await rawCall({ from: who, to: q.tx.to, data: q.tx.data, value: ethers.toQuantity(q.tx.value) }, overrides);
  const [amountOut] = flowAbi.decodeFunctionResult('executeSwap', out);
  const ok = (amountOut as bigint) >= q.minOut;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${fmtIn(amountIn)} -> simulated ${fmtOut(amountOut as bigint)} (quoted ${fmtOut(q.out)}, min ${fmtOut(q.minOut)})`);
  if (!ok) process.exitCode = 1;
  await new Promise((r) => setTimeout(r, 1200)); // Kuru Flow is 1 rps per token
}

const usd = (x: bigint) => `$${ethers.formatUnits(x, 6)}`;
const mon = (x: bigint) => `${ethers.formatEther(x)} MON`;
await simulate('MON -> AUSD', NATIVE, AUSD, ethers.parseEther('100'), mon, usd);
await simulate('AUSD -> MON', AUSD, NATIVE, 10_000_000n, usd, mon);
await simulate('USDC -> AUSD', USDC, AUSD, 100_000_000n, usd, usd);
