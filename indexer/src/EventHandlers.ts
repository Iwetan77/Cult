import { indexer } from "envio";
import {
  market,
  symbolFor,
  cnsToUsd,
  pnsToPrice,
  lnsToSize,
  sideLabel,
  ensureTrader,
} from "./helpers";

const ZERO = 0n;

interface PosState {
  id: string;
  perpId: bigint;
  accountId: bigint;
  owner: string;
  side: string;
  sizeLNS: bigint;
  realizedPnlCNS: bigint;
  entryPricePNS: bigint;
  openedAt: bigint;
  openTx: string;
  openBlock: bigint;
  status: string;
}

// --- helpers -------------------------------------------------------------

function eventId(tx: string, logIndex: number): string {
  return `${tx}-${logIndex}`;
}

async function getPosition(context: any, perpId: bigint, accountId: bigint): Promise<PosState | undefined> {
  return await context.PerplPosition.get(`${perpId}:${accountId}`);
}

function recordEvent(
  context: any,
  tx: string,
  block: bigint,
  logIndex: number,
  timestamp: bigint,
  owner: string,
  perpId: bigint,
  side: string,
  kind: string,
  pricePNS: bigint,
  sizeDeltaLNS: bigint,
  deltaPnlCNS: bigint,
  fundingCNS: bigint,
) {
  const cfg = market(perpId);
  const realizedCNS = deltaPnlCNS + fundingCNS;
  context.PositionEvent.set({
    id: eventId(tx, logIndex),
    venue: "PERPL",
    trader_id: owner,
    marketId: perpId,
    symbol: cfg.symbol,
    side,
    kind,
    price: pnsToPrice(pricePNS, cfg.priceDecimals),
    sizeDelta: lnsToSize(sizeDeltaLNS, cfg.sizeDecimals),
    deltaPnlCNS,
    fundingCNS,
    realizedPnlCNS: realizedCNS,
    timestamp,
    tx,
    block,
    logIndex,
  });
}

async function recordClosedTrade(
  context: any,
  pos: PosState,
  exitPricePNS: bigint,
  status: string,
  closedAt: bigint,
  closeTx: string,
  closeBlock: bigint,
  closeLogIndex: number,
  closedSizeLNS: bigint,
) {
  const cfg = market(pos.perpId);
  const pnlUsd = cnsToUsd(pos.realizedPnlCNS);
  const size = lnsToSize(closedSizeLNS, cfg.sizeDecimals);
  const entryPrice = pnsToPrice(pos.entryPricePNS, cfg.priceDecimals);
  const exitPrice = pnsToPrice(exitPricePNS, cfg.priceDecimals);
  const notional = entryPrice.times(size);

  context.Trade.set({
    id: `${pos.perpId}:${pos.accountId}:${closeBlock}:${closeLogIndex}`,
    venue: "PERPL",
    trader_id: pos.owner,
    marketId: pos.perpId,
    symbol: cfg.symbol,
    side: pos.side,
    status,
    size,
    entryPrice,
    exitPrice,
    notionalUsd: notional,
    realizedPnlCNS: pos.realizedPnlCNS,
    realizedPnlUsd: pnlUsd,
    isWin: pos.realizedPnlCNS > 0n,
    openedAt: pos.openedAt,
    closedAt,
    openTx: pos.openTx,
    closeTx,
    openBlock: pos.openBlock,
    closeBlock,
  });

  const trader = await context.Trader.get(pos.owner);
  if (trader) {
    const tradeCount = trader.tradeCount + 1;
    const winning = trader.winningTrades + (pos.realizedPnlCNS > 0n ? 1 : 0);
    const losing = trader.losingTrades + (pos.realizedPnlCNS > 0n ? 0 : 1);
    const totalCNS = trader.realizedPnlCNS + pos.realizedPnlCNS;
    context.Trader.set({
      ...trader,
      tradeCount,
      winningTrades: winning,
      losingTrades: losing,
      winRate: tradeCount === 0 ? 0 : winning / tradeCount,
      realizedPnlCNS: totalCNS,
      realizedPnlUsd: cnsToUsd(totalCNS),
      firstTradeAt: trader.firstTradeAt ?? closedAt,
      lastTradeAt: closedAt,
    });
  }
}

// --- AccountCreated -------------------------------------------------------

indexer.onEvent(
  { contract: "Exchange", event: "AccountCreated" },
  async ({ event, context }) => {
    const accountId = BigInt(event.params.id);
    const owner = String(event.params.account).toLowerCase();
    context.PerplAccount.set({ id: accountId, owner });
    await ensureTrader(context, owner);
  },
);

// --- PositionOpened -------------------------------------------------------

async function handleOpened(context: any, event: any, isV2: boolean) {
  const perpId = BigInt(event.params.perpId);
  const accountId = BigInt(event.params.accountId);
  const side = sideLabel(event.params.positionType);
  const lotLNS = BigInt(event.params.lotLNS);
  const pricePNS = BigInt(event.params.pricePNS);
  const tx = event.transaction.hash;
  const block = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

  const acct = await context.PerplAccount.get(accountId);
  if (!acct) return;
  const owner = acct.owner;

  const existing = await getPosition(context, perpId, accountId);
  if (existing && existing.status === "OPEN" && existing.sizeLNS > 0n) {
    // Defensive: a new open implies the previous round trip was already closed.
    await recordClosedTrade(
      context, existing, pricePNS, "CLOSED", ts, tx, block, event.logIndex, existing.sizeLNS,
    );
  }

  context.PerplPosition.set({
    id: `${perpId}:${accountId}`,
    perpId,
    accountId,
    owner,
    side,
    sizeLNS: lotLNS,
    realizedPnlCNS: 0n,
    entryPricePNS: pricePNS,
    openedAt: ts,
    openTx: tx,
    openBlock: block,
    status: "OPEN",
  });

  recordEvent(context, tx, block, event.logIndex, ts, owner, perpId, side, "OPENED", pricePNS, lotLNS, 0n, 0n);
}

indexer.onEvent(
  { contract: "Exchange", event: "PositionOpened" },
  async ({ event, context }) => handleOpened(context, event, false),
);

indexer.onEvent(
  { contract: "Exchange", event: "PositionOpenedV2" },
  async ({ event, context }) => handleOpened(context, event, true),
);

// --- PositionIncreased ----------------------------------------------------

async function handleIncreased(context: any, event: any) {
  const perpId = BigInt(event.params.perpId);
  const accountId = BigInt(event.params.accountId);
  const endLotLNS = BigInt(event.params.endLotLNS);
  const startLotLNS = BigInt(event.params.startLotLNS);
  const pricePNS = BigInt(event.params.pricePNS);
  const tx = event.transaction.hash;
  const block = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

  const pos = await getPosition(context, perpId, accountId);
  if (!pos) return;

  context.PerplPosition.set({
    ...pos,
    sizeLNS: endLotLNS,
    entryPricePNS: pricePNS,
  });

  recordEvent(
    context, tx, block, event.logIndex, ts, pos.owner, perpId, pos.side, "INCREASED",
    pricePNS, endLotLNS - startLotLNS, 0n, 0n,
  );
}

indexer.onEvent(
  { contract: "Exchange", event: "PositionIncreased" },
  async ({ event, context }) => handleIncreased(context, event),
);
indexer.onEvent(
  { contract: "Exchange", event: "PositionIncreasedV2" },
  async ({ event, context }) => handleIncreased(context, event),
);

// --- PositionDecreased ----------------------------------------------------

indexer.onEvent(
  { contract: "Exchange", event: "PositionDecreased" },
  async ({ event, context }) => {
    const perpId = BigInt(event.params.perpId);
    const accountId = BigInt(event.params.accountId);
    const endLotLNS = BigInt(event.params.endLotLNS);
    const startLotLNS = BigInt(event.params.startLotLNS);
    const deltaPnlCNS = BigInt(event.params.deltaPnlCNS);
    const fundingCNS = BigInt(event.params.fundingCNS);
    const tx = event.transaction.hash;
    const block = BigInt(event.block.number);
    const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

    const pos = await getPosition(context, perpId, accountId);
    if (!pos) return;

    // PositionDecreased doesn't carry a fill price, so use the current entry
    // price as a display-only fallback. Realized PnL comes from deltaPnlCNS +
    // fundingCNS regardless.
    const pricePNS = pos.entryPricePNS;
    const closedSize = startLotLNS - endLotLNS;
    const newPnl = pos.realizedPnlCNS + deltaPnlCNS + fundingCNS;

    recordEvent(
      context, tx, block, event.logIndex, ts, pos.owner, perpId, pos.side, "DECREASED",
      pricePNS, -closedSize, deltaPnlCNS, fundingCNS,
    );

    if (endLotLNS === 0n) {
      await recordClosedTrade(
        context, { ...pos, realizedPnlCNS: newPnl }, pricePNS, "CLOSED", ts, tx, block, event.logIndex, closedSize,
      );
      context.PerplPosition.set({ ...pos, sizeLNS: 0n, realizedPnlCNS: 0n, status: "CLOSED" });
    } else {
      context.PerplPosition.set({ ...pos, sizeLNS: endLotLNS, realizedPnlCNS: newPnl });
    }
  },
);

// --- PositionClosed -------------------------------------------------------

indexer.onEvent(
  { contract: "Exchange", event: "PositionClosed" },
  async ({ event, context }) => {
    const perpId = BigInt(event.params.perpId);
    const accountId = BigInt(event.params.accountId);
    const deltaPnlCNS = BigInt(event.params.deltaPnlCNS);
    const fundingCNS = BigInt(event.params.fundingCNS);
    const pricePNS = BigInt(event.params.pricePNS);
    const tx = event.transaction.hash;
    const block = BigInt(event.block.number);
    const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

    const pos = await getPosition(context, perpId, accountId);
    if (!pos) return;

    const closedSize = pos.sizeLNS;
    const newPnl = pos.realizedPnlCNS + deltaPnlCNS + fundingCNS;

    recordEvent(
      context, tx, block, event.logIndex, ts, pos.owner, perpId, pos.side, "CLOSED",
      pricePNS, -closedSize, deltaPnlCNS, fundingCNS,
    );

    await recordClosedTrade(
      context, { ...pos, realizedPnlCNS: newPnl }, pricePNS, "CLOSED", ts, tx, block, event.logIndex, closedSize,
    );
    context.PerplPosition.set({ ...pos, sizeLNS: 0n, realizedPnlCNS: 0n, status: "CLOSED" });
  },
);

// --- PositionInverted -----------------------------------------------------

indexer.onEvent(
  { contract: "Exchange", event: "PositionInverted" },
  async ({ event, context }) => {
    const perpId = BigInt(event.params.perpId);
    const accountId = BigInt(event.params.accountId);
    const newSide = sideLabel(event.params.positionType);
    const endLotLNS = BigInt(event.params.endLotLNS);
    const startLotLNS = BigInt(event.params.startLotLNS);
    const deltaPnlCNS = BigInt(event.params.deltaPnlCNS);
    const fundingCNS = BigInt(event.params.fundingCNS);
    const pricePNS = BigInt(event.params.pricePNS);
    const tx = event.transaction.hash;
    const block = BigInt(event.block.number);
    const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

    const pos = await getPosition(context, perpId, accountId);
    if (!pos) return;

    // Close the old side and record its realized PnL.
    const newPnl = pos.realizedPnlCNS + deltaPnlCNS + fundingCNS;
    recordEvent(
      context, tx, block, event.logIndex, ts, pos.owner, perpId, pos.side, "INVERTED",
      pricePNS, -startLotLNS, deltaPnlCNS, fundingCNS,
    );
    await recordClosedTrade(
      context, { ...pos, realizedPnlCNS: newPnl }, pricePNS, "INVERTED", ts, tx, block, event.logIndex, startLotLNS,
    );

    // Open the new opposite-side position.
    context.PerplPosition.set({
      ...pos,
      side: newSide,
      sizeLNS: endLotLNS,
      realizedPnlCNS: 0n,
      entryPricePNS: pricePNS,
      openedAt: ts,
      openTx: tx,
      openBlock: block,
      status: "OPEN",
    });
  },
);

// --- PositionLiquidated ---------------------------------------------------

indexer.onEvent(
  { contract: "Exchange", event: "PositionLiquidated" },
  async ({ event, context }) => {
    const perpId = BigInt(event.params.perpId);
    const accountId = BigInt(event.params.posAccountId);
    const liqLotLNS = BigInt(event.params.liqLotLNS);
    const posLotLNS = BigInt(event.params.posLotLNS);
    const deltaPnlCNS = BigInt(event.params.deltaPnlCNS);
    const fundingCNS = BigInt(event.params.fundingCNS);
    const pricePNS = BigInt(event.params.liqPricePNS);
    const tx = event.transaction.hash;
    const block = BigInt(event.block.number);
    const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

    const pos = await getPosition(context, perpId, accountId);
    if (!pos) return;

    const newPnl = pos.realizedPnlCNS + deltaPnlCNS + fundingCNS;
    const remaining = posLotLNS - liqLotLNS;

    recordEvent(
      context, tx, block, event.logIndex, ts, pos.owner, perpId, pos.side, "LIQUIDATED",
      pricePNS, -liqLotLNS, deltaPnlCNS, fundingCNS,
    );

    if (remaining <= 0n) {
      await recordClosedTrade(
        context, { ...pos, realizedPnlCNS: newPnl }, pricePNS, "LIQUIDATED", ts, tx, block, event.logIndex, liqLotLNS,
      );
      context.PerplPosition.set({ ...pos, sizeLNS: 0n, realizedPnlCNS: 0n, status: "CLOSED" });
    } else {
      context.PerplPosition.set({ ...pos, sizeLNS: remaining, realizedPnlCNS: newPnl });
    }
  },
);

// --- PositionDeleveraged --------------------------------------------------

async function handleDeleveraged(context: any, event: any) {
  const perpId = BigInt(event.params.perpId);
  const accountId = BigInt(event.params.accountId);
  const endLotLNS = BigInt(event.params.endLotLNS);
  const startLotLNS = BigInt(event.params.startLotLNS);
  const deltaPnlCNS = BigInt(event.params.deltaPnlCNS);
  const fundingCNS = BigInt(event.params.fundingCNS);
  const pricePNS = BigInt(event.params.deleveragePricePNS);
  const tx = event.transaction.hash;
  const block = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

  const pos = await getPosition(context, perpId, accountId);
  if (!pos) return;

  const closedSize = startLotLNS - endLotLNS;
  const newPnl = pos.realizedPnlCNS + deltaPnlCNS + fundingCNS;

  recordEvent(
    context, tx, block, event.logIndex, ts, pos.owner, perpId, pos.side, "DELEVERAGED",
    pricePNS, -closedSize, deltaPnlCNS, fundingCNS,
  );

  if (endLotLNS === 0n) {
    await recordClosedTrade(
      context, { ...pos, realizedPnlCNS: newPnl }, pricePNS, "DELEVERAGED", ts, tx, block, event.logIndex, closedSize,
    );
    context.PerplPosition.set({ ...pos, sizeLNS: 0n, realizedPnlCNS: 0n, status: "CLOSED" });
  } else {
    context.PerplPosition.set({ ...pos, sizeLNS: endLotLNS, realizedPnlCNS: newPnl });
  }
}

indexer.onEvent(
  { contract: "Exchange", event: "PositionDeleveraged" },
  async ({ event, context }) => handleDeleveraged(context, event),
);
indexer.onEvent(
  { contract: "Exchange", event: "PositionDeleveragedV2" },
  async ({ event, context }) => handleDeleveraged(context, event),
);

// --- PositionUnwound ------------------------------------------------------

async function handleUnwound(context: any, event: any) {
  const perpId = BigInt(event.params.perpId);
  const accountId = BigInt(event.params.accountId);
  const pricePNS = BigInt(event.params.pricePNS);
  // Unwind doesn't carry deltaPnlCNS/fundingCNS. The signed position fair-market
  // value is the closest realized-PnL proxy the contract reports.
  const fmvCNS = BigInt(event.params.positionFmvCNS);
  const tx = event.transaction.hash;
  const block = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

  const pos = await getPosition(context, perpId, accountId);
  if (!pos) return;

  const closedSize = pos.sizeLNS;
  const newPnl = pos.realizedPnlCNS + fmvCNS;

  recordEvent(
    context, tx, block, event.logIndex, ts, pos.owner, perpId, pos.side, "UNWOUND",
    pricePNS, -closedSize, fmvCNS, 0n,
  );

  await recordClosedTrade(
    context, { ...pos, realizedPnlCNS: newPnl }, pricePNS, "UNWOUND", ts, tx, block, event.logIndex, closedSize,
  );
  context.PerplPosition.set({ ...pos, sizeLNS: 0n, realizedPnlCNS: 0n, status: "CLOSED" });
}

indexer.onEvent(
  { contract: "Exchange", event: "PositionUnwound" },
  async ({ event, context }) => handleUnwound(context, event),
);
indexer.onEvent(
  { contract: "Exchange", event: "PositionUnwoundV2" },
  async ({ event, context }) => handleUnwound(context, event),
);
