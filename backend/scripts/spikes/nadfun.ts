// Spike C (discovery half): what Nad.fun actually has on the network we build
// against. Reads the v2 contracts on-chain and the testnet API's live token
// list, and tallies which quote asset each token trades against.
import { ethers } from 'ethers';
import { rpc } from '../../src/chain/signer.js';
import { NADFUN } from '../../src/nadfun/constants.js';

const p = rpc();
for (const [name, addr] of Object.entries({ router: NADFUN.router, bondingCurve: NADFUN.bondingCurve, factory: NADFUN.factory, wmon: NADFUN.wmon })) {
  console.log(name.padEnd(13), addr, `${(await p.getCode(addr)).length / 2 - 1} bytes`);
}

const res = await fetch(`${NADFUN.apiUrl}/order/latest_trade?page=1&limit=100`);
const body = (await res.json()) as { total_count: number; tokens: { token_info: any; market_info: any }[] };
console.log(`\n${NADFUN.apiUrl}: ${body.total_count} tokens`);
const tally = new Map<string, number>();
for (const t of body.tokens) {
  const k = `${t.market_info.quote_info?.symbol} ${t.market_info.quote_info?.quote_id} ${t.market_info.market_type}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k);

const monCurve = body.tokens.filter(
  (t) => t.market_info.market_type === 'V2_CURVE' && t.market_info.quote_info?.quote_id?.toLowerCase() === NADFUN.wmon.toLowerCase(),
);
console.log(`\n${monCurve.length} MON-quoted tokens still on the bonding curve, e.g.:`);
const router = new ethers.Contract(NADFUN.router, ['function getAmountOut(address,uint256,bool) view returns (uint256)'], p);
for (const t of monCurve.slice(0, 5)) {
  const out: bigint = await router.getAmountOut(t.token_info.token_id, ethers.parseEther('0.01'), true).catch(() => -1n);
  console.log(' ', t.token_info.symbol.padEnd(10), t.token_info.token_id, '0.01 MON buys', out >= 0n ? ethers.formatEther(out) : 'quote failed');
}
