import { indexer } from "envio";
import { monWeiToMon, ensureTrader } from "./helpers";

// Nad.fun is native-MON quoted. The router's Buy/Sell events carry the trader's
// wallet directly (indexed), so no account-id indirection is needed.
//
// Cost basis is average cost per (wallet, token), exactly as CONTRACTS.md spells
// out:
//   Buy:  qty += amountOut; cost += amountIn
//   Sell: realized += amountOut - cost * amountIn / qty;
//         cost -= cost * amountIn / qty; qty -= amountIn
// where on Buy amountIn = MON wei, amountOut = tokens, and on Sell the reverse.

interface NadPos {
  id: string;
  wallet: string;
  token: string;
  qtyRaw: bigint;
  costMonWei: bigint;
  realizedMonWei: bigint;
  peakQtyRaw: bigint;
  totalCostMonWei: bigint;
  totalProceedsMonWei: bigint;
  openedAt: bigint;
  openTx: string;
  openBlock: bigint;
  buyCount: number;
  sellCount: number;
  status: string;
}

async function getPos(context: any, wallet: string, token: string): Promise<NadPos | undefined> {
  return await context.NadFunPosition.get(`${wallet}:${token}`);
}

function recordEvent(
  context: any,
  tx: string,
  block: bigint,
  logIndex: number,
  ts: bigint,
  trader: string,
  token: string,
  kind: string,
  amountIn: bigint,
  amountOut: bigint,
  graduated: boolean,
) {
  context.NadFunEvent.set({
    id: `${tx}-${logIndex}`,
    trader_id: trader,
    token,
    kind,
    amountInRaw: amountIn,
    amountOutRaw: amountOut,
    graduated,
    timestamp: ts,
    tx,
    block,
    logIndex,
  });
}

async function closeRoundTrip(
  context: any,
  pos: NadPos,
  closeTx: string,
  closeBlock: bigint,
  closeLogIndex: number,
  closedAt: bigint,
) {
  context.NadFunTrade.set({
    id: `${pos.token}:${pos.wallet}:${closeBlock}:${closeLogIndex}`,
    venue: "NAD_FUN",
    trader_id: pos.wallet,
    token: pos.token,
    // null = the member's own trade. A mirror/stack trade is labelled by joining
    // openTx against the backend's GET /v1/indexer/txs (venue=nadfun, kind=
    // mirror_open|mirror_close|stack_open). Not set here — the backend owns the tag.
    origin: null,
    qtyRaw: pos.peakQtyRaw,
    costMon: monWeiToMon(pos.totalCostMonWei),
    proceedsMon: monWeiToMon(pos.totalProceedsMonWei),
    realizedPnlMon: monWeiToMon(pos.realizedMonWei),
    realizedPnlMonWei: pos.realizedMonWei,
    isWin: pos.realizedMonWei > 0n,
    buyCount: pos.buyCount,
    sellCount: pos.sellCount,
    openedAt: pos.openedAt,
    closedAt,
    openTx: pos.openTx,
    closeTx,
    openBlock: pos.openBlock,
    closeBlock,
  });

  const trader = await context.Trader.get(pos.wallet);
  if (trader) {
    const tradeCount = trader.tradeCount + 1;
    const winning = trader.winningTrades + (pos.realizedMonWei > 0n ? 1 : 0);
    const losing = trader.losingTrades + (pos.realizedMonWei > 0n ? 0 : 1);
    const totalMonWei = trader.realizedPnlMonWei + pos.realizedMonWei;
    context.Trader.set({
      ...trader,
      tradeCount,
      winningTrades: winning,
      losingTrades: losing,
      winRate: tradeCount === 0 ? 0 : winning / tradeCount,
      realizedPnlMonWei: totalMonWei,
      realizedPnlMon: monWeiToMon(totalMonWei),
      firstTradeAt: trader.firstTradeAt ?? closedAt,
      lastTradeAt: closedAt,
    });
  }
}

indexer.onEvent(
  { contract: "NadFunRouter", event: "Buy" },
  async ({ event, context }) => {
    const buyer = String(event.params.buyer).toLowerCase();
    const token = String(event.params.token).toLowerCase();
    const amountIn = BigInt(event.params.amountIn);   // MON wei
    const amountOut = BigInt(event.params.amountOut); // tokens
    const tx = event.transaction.hash;
    const block = BigInt(event.block.number);
    const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

    await ensureTrader(context, buyer);
    recordEvent(context, tx, block, event.logIndex, ts, buyer, token, "BUY", amountIn, amountOut, event.params.graduated);

    const pos = await getPos(context, buyer, token);
    if (!pos || pos.status === "CLOSED") {
      context.NadFunPosition.set({
        id: `${buyer}:${token}`,
        wallet: buyer,
        token,
        qtyRaw: amountOut,
        costMonWei: amountIn,
        realizedMonWei: 0n,
        peakQtyRaw: amountOut,
        totalCostMonWei: amountIn,
        totalProceedsMonWei: 0n,
        openedAt: ts,
        openTx: tx,
        openBlock: block,
        buyCount: 1,
        sellCount: 0,
        status: "OPEN",
      });
    } else {
      const newQty = pos.qtyRaw + amountOut;
      context.NadFunPosition.set({
        ...pos,
        qtyRaw: newQty,
        costMonWei: pos.costMonWei + amountIn,
        peakQtyRaw: newQty > pos.peakQtyRaw ? newQty : pos.peakQtyRaw,
        totalCostMonWei: pos.totalCostMonWei + amountIn,
        buyCount: pos.buyCount + 1,
      });
    }
  },
);

indexer.onEvent(
  { contract: "NadFunRouter", event: "Sell" },
  async ({ event, context }) => {
    const seller = String(event.params.seller).toLowerCase();
    const token = String(event.params.token).toLowerCase();
    const amountIn = BigInt(event.params.amountIn);   // tokens
    const amountOut = BigInt(event.params.amountOut); // MON wei
    const tx = event.transaction.hash;
    const block = BigInt(event.block.number);
    const ts = BigInt(event.block.timestamp) * 1000n // block timestamp is seconds; store ms;

    await ensureTrader(context, seller);
    recordEvent(context, tx, block, event.logIndex, ts, seller, token, "SELL", amountIn, amountOut, event.params.graduated);

    let pos = await getPos(context, seller, token);
    if (!pos) {
      // Tokens arrived outside the router (a transfer), so cost basis is zero.
      pos = {
        id: `${seller}:${token}`,
        wallet: seller,
        token,
        qtyRaw: amountIn,
        costMonWei: 0n,
        realizedMonWei: 0n,
        peakQtyRaw: amountIn,
        totalCostMonWei: 0n,
        totalProceedsMonWei: 0n,
        openedAt: ts,
        openTx: tx,
        openBlock: block,
        buyCount: 0,
        sellCount: 0,
        status: "OPEN",
      };
      context.NadFunPosition.set(pos);
    }

    const soldCost = pos.qtyRaw > 0n ? (pos.costMonWei * amountIn) / pos.qtyRaw : 0n;
    const realizedDelta = amountOut - soldCost;
    const newQty = pos.qtyRaw - amountIn;
    const newCost = pos.costMonWei - soldCost;
    const newRealized = pos.realizedMonWei + realizedDelta;
    const proceeds = pos.totalProceedsMonWei + amountOut;
    const sellCount = pos.sellCount + 1;

    if (newQty <= 0n) {
      const finalPos: NadPos = {
        ...pos,
        qtyRaw: 0n,
        costMonWei: 0n,
        realizedMonWei: newRealized,
        totalProceedsMonWei: proceeds,
        sellCount,
        status: "CLOSED",
      };
      context.NadFunPosition.set(finalPos);
      await closeRoundTrip(context, finalPos, tx, block, event.logIndex, ts);
    } else {
      context.NadFunPosition.set({
        ...pos,
        qtyRaw: newQty,
        costMonWei: newCost,
        realizedMonWei: newRealized,
        totalProceedsMonWei: proceeds,
        sellCount,
      });
    }
  },
);
