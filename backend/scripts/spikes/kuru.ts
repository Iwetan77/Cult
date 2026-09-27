// Spike D (discovery): does Kuru have a usable AUSD/USDC market on the network
// we build against? Reads Kuru's own market lists and the book on-chain.
import { ethers } from 'ethers';

const TARGET = '0x8cf49e35d73b19433ff4d4421637aabb680dc9cc';
const nets = [
  { name: 'testnet', rpc: 'https://testnet-rpc.monad.xyz', api: 'https://api.testnet.kuru.io/api/v1/markets' },
  { name: 'mainnet', rpc: 'https://rpc.monad.xyz', api: 'https://api.kuru.io/api/v1/markets?limit=500' },
];
const book = ['function getMarketParams() view returns (uint32,uint32,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)', 'function bestBidAsk() view returns (uint256,uint256)'];

for (const n of nets) {
  const p = new ethers.JsonRpcProvider(n.rpc);
  const code = await p.getCode(TARGET);
  console.log(`\n== ${n.name}: ${TARGET} code ${code.length / 2 - 1} bytes`);
  if (code !== '0x') {
    const c = new ethers.Contract(TARGET, book, p);
    const mp = await c.getMarketParams();
    const [a, b] = await c.bestBidAsk();
    console.log('   base', mp[2], 'quote', mp[4], 'bestBidAsk', a.toString(), b.toString(), a === ethers.MaxUint256 || b === 0n ? '(empty book)' : '');
  }
  const j: any = await (await fetch(n.api)).json();
  const rows: any[] = j.data?.data ?? j.data ?? [];
  const sym = (t: any) => t?.symbol ?? t?.ticker;
  const ausd = rows.filter((m) => JSON.stringify(m).toLowerCase().includes('ausd'));
  console.log(`   ${rows.length} markets listed, ${ausd.length} involving AUSD`);
  for (const m of ausd) console.log('  ', sym(m.baseToken ?? m.basetoken), '/', sym(m.quoteToken ?? m.quotetoken), m.marketAddress ?? m.market, 'liq', m.liquidity ?? '-', 'trades24h', m.tradeCount24h ?? (m.buyCount24h ?? 0) + (m.sellCount24h ?? 0));
  if (n.name === 'testnet') for (const m of rows) console.log('   testnet market', m.symbol, m.marketAddress, 'trades24h', m.tradeCount24h, 'last', m.lastPrice);
}
