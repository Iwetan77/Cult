// Option (b) end to end on Monad mainnet, simulated (no spend):
//   $5 of AUSD -> MON on Kuru Flow (real route + calldata, eth_call with an
//   AUSD balance override), then that exact MON -> a live MON-quoted Nad.fun
//   token via the mainnet v2 router's buyWithNative (eth_call with a MON
//   balance override). Both legs must return >= their guaranteed minimum.
import { ethers } from 'ethers';
import { flowAbi, KURU_FLOW_ROUTER, NATIVE, quoteSwap } from '../../src/swap/kuruFlow.js';
import { routerAbi } from '../../src/nadfun/trading.js';
import { erc20Overrides, MAINNET, rawCall } from './sim.js';

const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const NAD_ROUTER_MAINNET = '0x8986C8fD44eb85294A725a7e61AF35E76bA26F91';
const WMON_MAINNET = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
const who = ethers.Wallet.createRandom().address;
const ausdIn = 5_000_000n;

// Leg 1: AUSD -> MON
const q = await quoteSwap(who, AUSD, NATIVE, ausdIn);
const o1 = { [who]: { balance: ethers.toQuantity(ethers.parseEther('1')) }, ...(await erc20Overrides(AUSD, who, KURU_FLOW_ROUTER, ausdIn)) };
const [monOut] = flowAbi.decodeFunctionResult('executeSwap', await rawCall({ from: who, to: q.tx.to, data: q.tx.data }, o1)) as unknown as [bigint];
console.log(`${monOut >= q.minOut ? 'OK  ' : 'FAIL'} leg 1: $5 AUSD -> ${ethers.formatEther(monOut)} MON (min ${ethers.formatEther(q.minOut)})`);

// Pick a live MON-quoted mainnet token that the router quotes.
async function fetchJson(url: string, tries = 4): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) return r.json();
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
    }
  }
}
const list = (await fetchJson('https://api.nad.fun/order/latest_trade?page=1&limit=50')) as { tokens: { token_info: any; market_info: any }[] };
const router = new ethers.Contract(NAD_ROUTER_MAINNET, ['function getAmountOut(address,uint256,bool) view returns (uint256)'], MAINNET);
let token = '', expected = 0n, symbol = '';
for (const t of list.tokens) {
  if (t.market_info?.quote_info?.quote_id?.toLowerCase() !== WMON_MAINNET.toLowerCase()) continue;
  const out: bigint = await router.getAmountOut(t.token_info.token_id, monOut, true).catch(() => 0n);
  if (out > 0n) { token = t.token_info.token_id; expected = out; symbol = t.token_info.symbol; break; }
}
if (!token) throw new Error('no MON-quoted mainnet token quoting a buy');

// Leg 2: that exact MON -> meme, tokens to the buyer, 3% slippage floor.
const minTokens = (expected * 97n) / 100n;
const data = routerAbi.encodeFunctionData('buyWithNative', [{ amountOutMin: minTokens, token, to: who, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) }]);
const out = await rawCall({ from: who, to: NAD_ROUTER_MAINNET, data, value: ethers.toQuantity(monOut) }, { [who]: { balance: ethers.toQuantity(monOut + ethers.parseEther('1')) } });
const [tokensOut] = routerAbi.decodeFunctionResult('buyWithNative', out) as unknown as [bigint];
const ok = tokensOut >= minTokens;
console.log(`${ok ? 'OK  ' : 'FAIL'} leg 2: ${ethers.formatEther(monOut)} MON -> ${ethers.formatEther(tokensOut)} ${symbol} (${token}) via the mainnet Nad.fun router (min ${ethers.formatEther(minTokens)})`);
if (!ok || monOut < q.minOut) process.exitCode = 1;
