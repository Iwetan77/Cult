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

test('closing part of a position counts at once, with the exit price its PnL implies', async () => {
  const t = createTestIndexer();
  const common = { perpId: 48n, accountId: 9n, positionType: 0n };
  await t.process({
    chains: {
      10143: {
        startBlock: 66_310_001,
        endBlock: 66_310_006,
        simulate: [
          { contract: 'Exchange', event: 'AccountCreated', block: blk(1), transaction: tx(11), params: { account: OWNER, id: 9n } },
          // SOL (priceDecimals 2, sizeDecimals 3): long 2.000 at 150.00
          { contract: 'Exchange', event: 'PositionOpenedV2', block: blk(2), transaction: tx(12), params: { ...common, leverageHdths: 500n, depositCNS: 60_000_000n, pnlCollateralizedCNS: 0n, pricePNS: 15_000n, lotLNS: 2_000n, insFeeCNS: 0n } },
          // close one lot (0.500) for +$2.50 -> exit 155.00; $0.10 funding paid
          { contract: 'Exchange', event: 'PositionDecreased', block: blk(3), transaction: tx(13), params: { ...common, startDepositCNS: 0n, endDepositCNS: 0n, startLotLNS: 2_000n, endLotLNS: 1_500n, deltaPnlCNS: 2_500_000n, fundingCNS: -100_000n } },
          // close another 0.500 for -$1.00 -> exit 148.00
          { contract: 'Exchange', event: 'PositionDecreased', block: blk(4), transaction: tx(14), params: { ...common, startDepositCNS: 0n, endDepositCNS: 0n, startLotLNS: 1_500n, endLotLNS: 1_000n, deltaPnlCNS: -1_000_000n, fundingCNS: 0n } },
          // the rest at 160.00 for +$10.00
          { contract: 'Exchange', event: 'PositionClosed', block: blk(5), transaction: tx(15), params: { ...common, pricePNS: 16_000n, deltaPnlCNS: 10_000_000n, fundingCNS: 0n } },
        ],
      },
    },
  } as never);
  const trades = (await (t as any).Trade.getAll()).sort((a: any, b: any) => Number(a.closedAt) - Number(b.closedAt));
  assert.equal(trades.length, 3, 'one closed trade per close');
  assert.deepEqual(trades.map((x: any) => Number(x.size)), [0.5, 0.5, 1]);
  assert.deepEqual(trades.map((x: any) => Number(x.exitPrice)), [155, 148, 160]);
  assert.deepEqual(trades.map((x: any) => Number(x.realizedPnlUsd)), [2.4, -1, 10]);
  assert.deepEqual(trades.map((x: any) => x.isWin), [true, false, true]);
  for (const x of trades) assert.equal(x.openTx, tx(12).hash);
  const trader = await (t as any).Trader.get(OWNER);
  assert.equal(trader.tradeCount, 3);
  assert.equal(Number(trader.realizedPnlUsd), 11.4);
  assert.equal(trader.winningTrades, 2);
});

test('a short reduce implies its exit price the other way', async () => {
  const { exitPriceFromPnl, market } = await import('../src/helpers.ts');
  // short 1.000 SOL at 150.00, buying back 0.5 for +$5 means the price fell to 140.00
  assert.equal(exitPriceFromPnl(15_000n, 5_000_000n, 500n, 'SHORT', market(48n)), 14_000n);
  assert.equal(exitPriceFromPnl(15_000n, 5_000_000n, 500n, 'LONG', market(48n)), 16_000n);
  assert.equal(market(336n).symbol, 'NEAR');
  assert.equal(market(110n).symbol, 'UNI');
});
