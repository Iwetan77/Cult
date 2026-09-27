// Kuru Flow on Monad mainnet, proven without spending anything:
//   1. get a live quote from Kuru's routing API
//   2. run it through checkQuoteTx (router, executeSwap only, intent, zero fees)
//   3. execute that exact calldata as an eth_call on mainnet, from a throwaway
//      address given a balance (and allowance) via state overrides, so the
//      real route runs against real liquidity and must return >= minOut.
// ERC20 balance/allowance slots are found by probing, not assumed.
import { ethers } from 'ethers';
import { checkQuoteTx, flowAbi, KURU_FLOW_ROUTER, NATIVE, quoteSwap } from '../../src/swap/kuruFlow.js';
import { erc20Overrides, rawCall } from './sim.js';

const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

async function simulate(label: string, tokenIn: string, tokenOut: string, amountIn: bigint, fmtIn: (x: bigint) => string, fmtOut: (x: bigint) => string) {
  const who = ethers.Wallet.createRandom().address;
  const q = await quoteSwap(who, tokenIn, tokenOut, amountIn);
  checkQuoteTx(q.tx, { tokenIn, tokenOut, amountIn }); // (quoteSwap already did; explicit for the record)
  const overrides: Record<string, unknown> = { [who]: { balance: ethers.toQuantity(ethers.parseEther('1000000')) } };
  if (tokenIn !== NATIVE) {
    const o = await erc20Overrides(tokenIn, who, KURU_FLOW_ROUTER, amountIn);
    if (!o) {
      console.log(`${label}: quote OK (out ${fmtOut(q.out)}, min ${fmtOut(q.minOut)}), but couldn't locate ${tokenIn} storage to simulate`);
      return;
    }
    Object.assign(overrides, o);
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
