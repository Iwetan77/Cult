// Spike A: print every market Perpl actually lists, straight from /v1/pub/context,
// plus the live fee schedule and latest funding rate per market.
import { env } from '../../src/config/env.js';

interface Market {
  id: number;
  symbol: string;
  name: string;
  funding_interval_sec: number;
  funding_interval_blocks: number;
  config: {
    is_open: boolean;
    initial_margin: number;
    maintenance_margin: number;
    maker_fees?: number[];
    taker_fees?: number[];
    maker_fee: number;
    taker_fee: number;
  };
  funding?: { rate: number; at: { t: number } };
}

const res = await fetch(`${env.perplApiUrl}/v1/pub/context`);
if (!res.ok) throw new Error(`context ${res.status}`);
const ctx = (await res.json()) as { chain: { chain_id: number }; markets: Market[]; instances: unknown[]; tokens: unknown[] };

console.log(`chain ${ctx.chain.chain_id} @ ${env.perplApiUrl}`);
console.log('instances', JSON.stringify(ctx.instances));
console.log('tokens', JSON.stringify(ctx.tokens));
console.log('id\tsymbol\topen\tmaxLev\tmaker(bps)\ttaker(bps)\tfundingEvery\tlastRate(bps)');
for (const m of ctx.markets) {
  const c = m.config;
  const bps = (micros: number) => (micros / 100).toFixed(2);
  console.log(
    [
      m.id,
      m.symbol || m.name,
      c.is_open,
      `${(10000 / c.initial_margin).toFixed(1)}x`,
      bps(c.maker_fee),
      bps(c.taker_fee),
      `${m.funding_interval_sec}s/${m.funding_interval_blocks}blk`,
      m.funding ? bps(m.funding.rate) : '-',
    ].join('\t'),
  );
}
