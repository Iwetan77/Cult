// "Pay with USDC" against Monad mainnet, without spending: build a real plan
// (live Kuru Flow route + mainnet Perpl), check each action, and simulate the
// swap step with eth_call + a USDC balance override.
process.env.PERPL_API_URL = 'https://app.perpl.xyz/api';
process.env.PERPL_CHAIN_ID = '143';
process.env.ALCHEMY_MONAD_RPC_URL = process.env.MAINNET_RPC_URL ?? 'https://rpc.monad.xyz';

const { ethers } = await import('ethers');
const { prepareUsdcFunding, USDC_MAINNET } = await import('../../src/funding/plan.js');
const { flowAbi, KURU_FLOW_ROUTER } = await import('../../src/swap/kuruFlow.js');
const { exchangeAbi, erc20Abi } = await import('../../src/chain/exchange.js');
const { erc20Overrides, rawCall } = await import('./sim.js');

const who = ethers.Wallet.createRandom().address;
const plan = await prepareUsdcFunding(who, 25_000_000n, true); // $25 USDC -> AUSD -> open a mainnet Perpl account
console.log(`plan ${plan.id}: $25 USDC -> expected $${ethers.formatUnits(plan.expectedAusdOut, 6)}, guaranteed $${ethers.formatUnits(plan.minAusdOut, 6)}`);
for (const a of plan.actions) {
  const iface = a.to.toLowerCase() === KURU_FLOW_ROUTER.toLowerCase() ? flowAbi : a.data.startsWith(erc20Abi.getFunction('approve')!.selector) ? erc20Abi : exchangeAbi;
  const d = iface.parseTransaction({ data: a.data, value: a.value ? BigInt(a.value) : 0n });
  console.log(` - ${a.label.padEnd(28)} ${a.to} ${d?.name}(${d?.args.map((x: unknown) => (Array.isArray(x) ? `[${x.map(String).join(',')}]` : String(x)).slice(0, 80)).join(', ')})`);
}
const swapStep = plan.actions.find((a) => a.to.toLowerCase() === KURU_FLOW_ROUTER.toLowerCase())!;
const overrides = { [who]: { balance: ethers.toQuantity(ethers.parseEther('10')) }, ...(await erc20Overrides(USDC_MAINNET, who, KURU_FLOW_ROUTER, 25_000_000n)) };
const out = await rawCall({ from: who, to: swapStep.to, data: swapStep.data }, overrides);
const [amountOut] = flowAbi.decodeFunctionResult('executeSwap', out);
const ok = (amountOut as bigint) >= BigInt(plan.minAusdOut);
console.log(`${ok ? 'OK  ' : 'FAIL'} simulated swap step: $25 USDC -> $${ethers.formatUnits(amountOut as bigint, 6)} AUSD (guaranteed $${ethers.formatUnits(plan.minAusdOut, 6)})`);
const dep = plan.actions.at(-1)!;
const depAmount = exchangeAbi.parseTransaction({ data: dep.data })!.args[0] as bigint;
if (depAmount !== BigInt(plan.minAusdOut)) { console.log('FAIL deposit amount != guaranteed swap output'); process.exitCode = 1; }
if (!ok) process.exitCode = 1;
