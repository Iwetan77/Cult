# CONTRACTS

Shared contract between the `backend`, `frontend` and `indexer` branches. Types, env
vars, endpoints and cross-branch decisions live here. If you need something from
another branch, add it here instead of editing their folder.

## Layout

| Area | Path | Owner |
|------|------|-------|
| Backend service (TypeScript/Node) | `/backend` | `backend` branch |
| Frontend | `/frontend` | `frontend` branch |
| Indexer (Envio HyperIndex) | `/indexer` | `indexer` branch |

## Network constants (Perpl testnet, verified live 2026-09-26)

Read from `GET https://testnet.perpl.xyz/api/v1/pub/context`. Always re-read at runtime
instead of hard-coding. These are for reference only.

| Key | Value |
|-----|-------|
| Chain ID | `10143` (Monad testnet) |
| REST base | `https://testnet.perpl.xyz/api` |
| WS base | `wss://testnet.perpl.xyz` (no `/api` prefix) |
| Exchange contract | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |
| Collateral token | AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`, 6 decimals |
| Min account open | `100000000` raw = 100 AUSD (mainnet is 10 AUSD) |
| Min deposit | 10 AUSD |

The `.env.example` in Perpl's api-docs repo still lists the old testnet collateral
(`0xdf5b…`, "Test USD"). That's stale. Context and the docs site both say
`0xa9012a…` AUSD.

### Markets returned by the live API

Testnet:

| id | symbol | max lev | maker bps | taker bps |
|----|--------|---------|-----------|-----------|
| 16 | BTC | 6.7x | 0.45 | 3.45 |
| 32 | ETH | 8.3x | 0.45 | 3.45 |
| 48 | SOL | 10x | 0.45 | 3.45 |
| 64 | MON | 33.3x | 0.45 | 3.45 |
| 256 | ZEC | 33.3x | 0.45 | 3.45 |
| 272 | LIT | 33.3x | 0.45 | 3.45 |
| 320 | PUMP | 20x | 0.45 | 3.45 |

Mainnet: BTC(1), MON(10), ETH(20), SOL(31), HYPE(40), ZEC(50), LIT(60), VVV(70), PUMP(90).

Reproduce with `cd backend && npm run spike:markets`.

### Fees and funding (live values)

- Fees are in micros (1e-6) per market per tier, indexed by `Account.ft`. Current
  schedule on every market: maker `[45,25,15,0,…]`, taker `[345,300,250,210,175,150,125,0]`.
  So base tier is 0.45 bps maker / 3.45 bps taker. Tiers come from rolling 14-day volume.
- Fees are charged on every fill that changes position size (open and close).
- Funding: one event every 8571 blocks (~43 min at current block times,
  `funding_interval_sec: 2580`). The rate is in micros and clamped on-chain. A positive
  rate means longs pay shorts. Recent BTC testnet rates are 0–40 micros per interval.
- History: `GET /api/v1/market-data/:id/funding/:from-:to` (public).

## Open blockers (Phase 0). Need a decision before Phase 1

1. **No Monad-native meme market exists on Perpl (testnet or mainnet).** The only
   meme-ish listing is `PUMP`, which is pump.fun's Solana token, not Monad-native. `MON`
   is Monad's L1 token, not a meme. Per spec this is flagged, not worked around.
   Product decision needed.
2. **Delegated trading: supported by design, not yet proven end to end.** Perpl API keys
   are Ed25519 keys the owner's wallet authorizes once (EIP-712). Scope `trade` can
   place, cancel and modify orders. **Withdrawals and transfers-out are never allowed via
   an API key, at any scope.** So "backend holds a trade-scoped key per member" is the
   intended pattern. Two more on-chain prerequisites per member: `createAccount` and
   `allowOrderForwarding(true)`, both signed by the member's own wallet. Server-side
   enrollment with no `Origin` header passes `/payload`. `/enroll` returns 404 until the
   wallet has a Perpl account. The real order-placement gate is blocked on a funded
   testnet wallet (MON for gas + 100 testnet AUSD). Testnet AUSD has no public mint.
3. **Agora stable-swap cannot do USDC→AUSD on Monad testnet, and is KYC-gated
   everywhere.** Agora's Protocol Deployments page lists only a `CTK / AUSD` pair on
   Monad testnet (`0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae`, whitelister
   `0x7c10F56d6f04a51376393a1C3670e966863F6BD5`). Mainnet has `AUSD / USDC`
   (`0xf33286E3222D1c829dACeac48c0Ec651F6452470`). The protocol is "available exclusively
   to verified platform users through a protected whitelist" (KYC). The per-user
   USDC→AUSD flow in the spec doesn't work as written unless every user is whitelisted
   or Cult gets whitelisted as the swapper.

## Backend env vars

See `backend/.env.example`. The frontend and indexer should not need any of these.


## Indexer — verified track record (Perpl)

The `indexer` branch (Envio HyperIndex) indexes Perpl's on-chain position events on
Monad testnet (chain `10143`) and exposes per-address **win rate**, **realized PnL**
and **trade history** over GraphQL. Backend consumes this to fill the `Member`
`winRate` / `realizedPnlUsd` / `tradeCount` fields and the public share cards.

### On-chain events indexed (Exchange `0x1964C32f0bE608E7D29302AFF5E61268E72080cc`)

Signatures verified from Perpl's `dex-sdk` ABI (`abi/dex/Exchange.json`). All amount
fields are `uint256`/`int256` in CNS (AUSD * 1e6); prices are PNS (per-market
`price_decimals`), sizes are LNS (per-market `size_decimals`).

| Event | Fields used | Meaning |
|-------|-------------|---------|
| `AccountCreated(address account, uint256 id)` | `account`, `id` | wallet -> account id |
| `PositionOpened(perpId, accountId, positionType, leverageHdths, depositCNS, pnlCollateralizedCNS, pricePNS, lotLNS, insFeeCNS, protFeeCNS)` | perpId, accountId, positionType, pricePNS, lotLNS | new position |
| `PositionIncreased(... startLotLNS, endLotLNS, pricePNS, ...)` | as above | size up |
| `PositionDecreased(... startLotLNS, endLotLNS, deltaPnlCNS, fundingCNS)` | as above | partial close (realized PnL) |
| `PositionClosed(perpId, accountId, positionType, pricePNS, deltaPnlCNS, fundingCNS)` | as above | full close (realized PnL) |
| `PositionInverted(... pricePNS, startLotLNS, endLotLNS, deltaPnlCNS, fundingCNS)` | as above | flip side |
| `PositionLiquidated(perpId, posAccountId, ..., liqPricePNS, liqLotLNS, posLotLNS, deltaPnlCNS, fundingCNS, ...)` | as above | liquidation |
| `PositionDeleveraged(... deleveragePricePNS, startLotLNS, endLotLNS, deltaPnlCNS, fundingCNS, ...)` | as above | deleverage |
| `PositionUnwound(... pricePNS, lotLNS, depositCNS, positionFmvCNS, paymentCNS, ...)` | positionFmvCNS | unwind |

`positionType` is `0 = Long, 1 = Short` on-chain. `V2` variants exist for most events
and add a `priceResiduePNSQ16` field; they are indexed alongside their V1 names.

### Computed stats (definitions)

- **Realized PnL** = sum of `(deltaPnlCNS + fundingCNS)` across every close-type event
  (`Decreased`, `Closed`, `Liquidated`, `Deleveraged`, `Inverted`) over a position's
  life. `Unwound` contributes `positionFmvCNS` (its signed fair-market value).
- **A trade** = a position round trip: opened (size > 0), then fully closed (size back
  to 0) or a terminal event (liquidated / deleveraged-to-zero / unwound / inverted).
- **Win rate** = profitable closed trades / total closed trades; a trade is a win when
  its cumulative realized PnL > 0.
- **"Recent" PnL** is derived at query time, not stored: filter `Trade` on
  `closedAt >= now - window`. `Trader.realizedPnlUsd` is all-time; any window is a
  sum over the matching `trades`.
- **Known gap (reconcile at GATE)**: funding settled on position *increase*
  (`PositionIncreased.premiumPnlSettledCNS`) is not yet counted. Second-order (funding
  only). Also not yet indexed: raw `MakerOrderFilled`/`TakerOrderFilled` fills (the
  position-level history covers the "real timestamped list" requirement).

### Read API (GraphQL, generated by Envio)

Entities: `Trader` (per address), `Trade` (closed round trips), `PositionEvent`
(granular lifecycle history), `PerplAccount` (account id -> owner). Backend queries
`Trader(id: <wallet>)`.

```graphql
query MemberStats($addr: String!) {
  Trader(id: $addr) {
    tradeCount
    winningTrades
    losingTrades
    winRate            # 0..1
    realizedPnlUsd
    realizedPnlCNS     # raw USD * 1e6
    trades(order_by: { closedAt: desc }) {
      symbol side size entryPrice exitPrice realizedPnlUsd isWin openedAt closedAt
    }
  }
}
```

```json
{
  "data": {
    "Trader": {
      "tradeCount": 12,
      "winningTrades": 7,
      "losingTrades": 5,
      "winRate": 0.5833,
      "realizedPnlUsd": "143.21",
      "realizedPnlCNS": "143210000",
      "trades": [
        { "symbol": "BTC", "side": "LONG", "size": "0.1", "entryPrice": "84000",
          "exitPrice": "85000", "realizedPnlUsd": "100.00", "isWin": true,
          "openedAt": "1750000000000", "closedAt": "1750003600000" }
      ]
    }
  }
}
```

### GATE status (blocked, not shipped)

Perpl testnet AUSD has no public mint, so no funded account has traded recently
(last `AccountCreated` scan found nothing in ~6k blocks). The validation target is
backend's Phase 1 end-to-end test, which will produce a funded address that has
actually traded plus its API key. **Indexer needs from backend**: that E2E wallet
address (and its Perpl API key if available) to diff `winRate` / `realizedPnl` /
`tradeCount` against `GET /v1/trading/position-history` + `/account-history`.

### Nad.fun (second venue) — blocked on backend Spike C

Nad.fun token buys/sells (bonding curve + graduation) are the meme venue. The
indexer is designed multi-venue (`Venue.PERPL | NAD_FUN`) but **cannot index it
without the real contract addresses and event signatures**. Indexer needs from
backend (Spike C): Nad.fun testnet contract addresses, the buy/sell event
signatures + fields, and how a buy/sell maps to cost basis and realized PnL.
Do not guess these — a wrong event shape corrupts every verified stat downstream.
