# Cult indexer

Envio [HyperIndex](https://docs.envio.dev) indexer that turns Perpl's on-chain
trading events on Monad testnet into **verified, per-address** win rate, realized
PnL and trade history. This is the "verified track record" backend for Cult clans —
it reads the chain directly because Perpl's own history endpoints are per-account
and authenticated, so there's no cross-user public feed to build on.

## What it computes

For every wallet that has traded on Perpl:

- **Win rate** — profitable closed trades / total closed trades. A "trade" is a
  position round trip (opened, then fully closed / liquidated / deleveraged /
  unwound / inverted). A trade is a win when its realized PnL is positive.
- **Realized PnL** — all-time, in USD. Sum of the contract's own reported realized
  PnL (`deltaPnlCNS + fundingCNS`) across every close-type position event. Raw CNS
  (USD * 1e6) is stored alongside the USD decimal so nothing loses precision.
- **Trade history** — a real, timestamped list. `PositionEvent` is the granular
  event-by-event history (open / increase / decrease / close / liquidation /
  deleverage / inversion / unwind), and `Trade` is the rolled-up round trips.

## Prerequisites

- Node 20+ (HyperIndex needs import-attributes; Node 18 is too old)
- Docker (for the local Postgres + Hasura stack `envio dev`/`start` spins up)
- An [Envio API token](https://envio.dev/app/api-tokens) for HyperSync
- pnpm (or npm — the scripts below use pnpm, swap freely)

## Setup (cold)

```bash
cd indexer
npm install          # pulls the `envio` CLI + codegen deps
npm run codegen      # generates handler types from config.yaml + schema.graphql
```

Create the env file Envio reads for HyperSync auth and (optional) RPC fallback:

```bash
cp .env.example .env
# ENVIO_API_TOKEN=...   (required for HyperSync)
# PERPL_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz
```

## Run

```bash
npm run dev          # local dev: codegen + Postgres + Hasura + sync
npm run start        # production-ish local run
npm run test         # run the test suite (see test/)
```

Once `dev` is up, the auto-generated GraphQL API (Hasura) is available locally at
`http://localhost:8080/v1/graphql`. The entity data is in Postgres
(`postgres://postgres:testing@localhost:5433/...`).

## Config

`config.yaml`:

- `chains[].id: 10143` — Monad testnet. HyperSync is the primary data source; the
  public testnet RPC is listed as `fallback`.
- `start_block: 62953` — Perpl testnet exchange deploy block.
- `contracts.Exchange.abi_file_path` — trimmed Perpl Exchange ABI (events only).
- Events indexed: `AccountCreated` plus the full `Position*` lifecycle
  (`Opened`/`Increased`/`Decreased`/`Closed`/`Inverted`/`Liquidated`/
  `Deleveraged`/`Unwound`, including `V2` variants).

Mainnet is the same ABI at `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` (chain
143, deploy block `54773010`) — add a second chain entry to switch.

## Data model

See `schema.graphql`. The important part is how the indexer joins account ids back
to wallets and reconstructs round trips:

- `AccountCreated(address, id)` maps each on-chain account id to its owner wallet
  (`PerplAccount`).
- Every position event references `accountId`, not the wallet. Handlers look that
  id up in `PerplAccount` and attribute the event to the owning address.
- `PerplPosition` (`@internal`) tracks the open position per `(perpId, accountId)`
  and accumulates realized PnL across the position's life. When the size returns to
  zero (or a terminal event fires), the accumulated PnL is written as a `Trade` and
  the trader's stats are updated.

### Realized PnL definition

`deltaPnlCNS` (price PnL) + `fundingCNS` (funding PnL) per close-type event, both
int256 in CNS (USD * 1e6), summed over the position's life. This is exactly what the
contract reports as realized at close/decrease/liquidate/deleverage/invert time.

Known gap to reconcile during validation: funding that is *settled on position
increase* (`PositionIncreased.premiumPnlSettledCNS`) is not yet counted. It's a
second-order term (funding only) and is flagged in `CONTRACTS.md` for the GATE
cross-check.

## Read API

The indexer exposes GraphQL (Envio's generated API). Example — a member's verified
stats and history for wallet `0xabc…`:

```graphql
query MemberStats($addr: String!) {
  Trader(id: $addr) {
    tradeCount
    winningTrades
    losingTrades
    winRate
    realizedPnlUsd
    realizedPnlCNS
    trades(order_by: { closedAt: desc }) {
      symbol
      side
      size
      entryPrice
      exitPrice
      realizedPnlUsd
      isWin
      closedAt
    }
  }
}
```

See `CONTRACTS.md` for the full contract and example responses.

## Validation (GATE)

The gate is: pick one real testnet address that has actually traded on Perpl and
prove the indexer's win rate / PnL matches Perpl's own position history. That needs
a funded testnet account, which is blocked until backend's Phase 1 end-to-end test
lands (testnet AUSD has no public mint). See `CONTRACTS.md` for the open dependency
and the exact reconciliation steps once it's unblocked.
