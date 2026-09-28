// Perpl handler rules on simulated events (no chain, no Postgres):
// entry is the size-weighted average after an add, funding settled on an add
// counts as realized PnL, and maker fills land on the owner's history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestIndexer } from 'envio';

const OWNER = '0x00000000000000000000000000000000000000aa';
const blk = (n: number) => ({ number: 66_310_000 + n, timestamp: 1_790_000_000 + n });
const tx = (n: number) => ({ hash: '0x' + n.toString(16).padStart(64, '0') });

test('open, add at a higher price, close: averaged entry, funding from the add, one round trip', async () => {
  const t = createTestIndexer();
  const common = { perpId: 16n, accountId: 7n, positionType: 0n };
  await t.process({
    chains: {
      10143: {
        startBlock: 66_310_001,
        endBlock: 66_310_005,
        simulate: [
          { contract: 'Exchange', event: 'AccountCreated', block: blk(1), transaction: tx(1), params: { account: OWNER, id: 7n } },
          // BTC (priceDecimals 1, sizeDecimals 5): open 1.00000 at 100000.0
          { contract: 'Exchange', event: 'PositionOpenedV2', block: blk(2), transaction: tx(2), params: { ...common, leverageHdths: 500n, depositCNS: 20_000_000_000n, pnlCollateralizedCNS: 0n, pricePNS: 1_000_000n, lotLNS: 100_000n, insFeeCNS: 0n } },
          // add 1.00000 at 110000.0; 3 USD of funding settled into collateral
          { contract: 'Exchange', event: 'PositionIncreasedV2', block: blk(3), transaction: tx(3), params: { ...common, leverageHdths: 500n, startDepositCNS: 0n, endDepositCNS: 0n, pnlCollateralizedCNS: 0n, premiumPnlSettledCNS: 3_000_000n, maxNegPnlCollatBPS: 0n, pricePNS: 1_100_000n, startLotLNS: 100_000n, endLotLNS: 200_000n, insFeeCNS: 0n, protFeeCNS: 0n, priceResiduePNSQ16: 0n } },
          // a maker fill on the account
          { contract: 'Exchange', event: 'MakerOrderFilledV2', block: blk(3), transaction: tx(4), params: { perpId: 16n, accountId: 7n, orderId: 42n, pricePNS: 1_100_000n, lotLNS: 100_000n, feeCNS: 250_000n, lockedBalanceCNS: 0n, amountCNS: 0n, balanceCNS: 0n, builderId: 0n, builderFeeCNS: 0n } },
          // close all at 120000.0 for +30000 USD, 5 USD funding paid
          { contract: 'Exchange', event: 'PositionClosed', block: blk(4), transaction: tx(5), params: { ...common, pricePNS: 1_200_000n, deltaPnlCNS: 30_000_000_000n, fundingCNS: -5_000_000n } },
        ],
      },
    },
  } as never);
  const trades = await (t as any).Trade.getAll();
  assert.equal(trades.length, 1, 'one round trip');
  const tr = trades[0];
  assert.equal(Number(tr.entryPrice), 105000, 'size-weighted: (100000 + 110000) / 2');
  assert.equal(Number(tr.realizedPnlUsd), 29998, '30000 - 5 funding at close + 3 funding settled on the add');
  const trader = await (t as any).Trader.get(OWNER);
  assert.equal(trader.tradeCount, 1);
  const fills = await (t as any).PerplFill.getAll();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].trader_id, OWNER);
  assert.equal(Number(fills[0].feeUsd), 0.25);
  assert.equal(Number(fills[0].size), 1);
});
