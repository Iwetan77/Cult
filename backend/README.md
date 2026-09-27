# Cult backend

The orchestration service behind Cult's trading clans. It holds each member's
trading session, runs the auto-mirror engine across two venues (**Perpl** perps
and **Nad.fun** memes), scopes everything it signs through **Privy** policies,
and serves the API the frontend and indexer read. The shared API contract lives
in [`../CONTRACTS.md`](../CONTRACTS.md).

## Run it

Requirements: Node 22 or newer (it uses the built-in `node:sqlite`).

```bash
cp .env.example .env     # then fill in the values below
npm ci
npm start                # http://localhost:8787, all routes under /v1
```

| Variable | What it's for |
|---|---|
| `PERPL_API_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID` | Perpl network (testnet defaults) |
| `ALCHEMY_MONAD_RPC_URL` | RPC for on-chain reads and writes. Falls back to the public Monad RPC |
| `KEY_ENCRYPTION_SECRET` | 32-byte hex. Seals members' Perpl API-key secrets at rest (AES-256-GCM) |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Verifies Privy access tokens, looks up embedded wallets, creates policies |
| `PRIVY_BACKEND_AUTH_KEY`, `PRIVY_BACKEND_KEY_QUORUM_ID` | The backend's own Privy signer (P-256), added to member wallets under policy |
| `INDEXER_API_KEY` | Shared secret for `/v1/indexer/*` |
| `MIRROR_OPT_OUT_SECONDS` | Skip window before a mirror fires (provisional: 20) |
| `CORS_ORIGINS`, `PUBLIC_APP_URL` | Frontend origin(s), and the base for share links |
| `NADFUN_PAY_WITH` | `ausd` (swap via Kuru Flow; default on mainnet) or `mon` (default on testnet) |
| `FUNDER_PRIVATE_KEY` | **Test scripts only.** A throwaway testnet wallet that seeds fresh wallets |

Never commit `.env`. It's git-ignored.

## How it fits together

```
src/
  venues/        one trade interface (open/close/holdings/balance/price) over both venues
    perpl.ts       orders over the member's Perpl trading websocket (Ed25519 API key)
    nadfun.ts      buy/sell txs from the member's wallet via the Nad.fun v2 router
  mirror/        auto-mirror engine, sizing, manual stack (separate on purpose), repo
  nadfun/        router ABI, trading, log watcher (leader detection for memes)
  perpl/         REST + websocket client, signing, enrollment, types
  privy/         token verification, the policy the backend signer runs under
  trading/       Perpl position helpers, TP/SL as Perpl trigger orders
  swap/          Kuru Flow quotes, checked before signing (router, executeSwap only, no fees)
  funding/       "pay with USDC": Kuru Flow USDC -> AUSD -> optional Perpl deposit (mainnet)
  api/           Hono routes, chart snapshot, shares, TP/SL suggestions
  store/         SQLite schema + repositories
```

**The safety model:**

- **Perpl:** trading uses an Ed25519 API key the member's wallet authorizes once.
  Perpl never lets an API key withdraw, at any scope.
- **Nad.fun:** trading is wallet transactions, signed through the backend's Privy
  signer. Privy's policy engine refuses anything off-scope: withdrawals, transfers
  out, output routed to anyone but the member, amounts over the member's cap, and
  signing Perpl setup or enrollment (the member does that once, in the browser).
- **Anti-feedback:** every order the engine sends is tagged before it leaves (Perpl
  request id, Nad.fun tx hash). That way a mirror can never be mistaken for a new
  leader trade.

## Checks

```bash
npm run typecheck
npm test                         # sizing, engine logic (fake venues), TP/SL parsing
npx tsx scripts/smoke-api.ts     # every route against a throwaway DB + live market data
```

The gates run against real networks. Each one writes its evidence (tx hashes, API
reads) to `data/evidence/`.

| Gate | Command | Status |
|---|---|---|
| Spike A: Perpl markets | `npm run spike:markets` | passed |
| Spike B: order via delegated key | `npm run spike:perpl-order` | **not run**: needs Perpl testnet AUSD |
| Spike C: real Nad.fun buy + sell | `npm run spike:nadfun-trade` | passed |
| Spike D: Kuru USDC→AUSD | `npm run spike:kuru-flow` | **simulated on mainnet** (real route + calldata via `eth_call`; no spend) |
| Phase 1: account lifecycle, trade, TP/SL | `npm run e2e:phase1` | **not run**: needs Perpl testnet AUSD |
| Memes paid in $: AUSD→MON→meme | `npm run spike:meme-buy-sim` | **simulated on mainnet**: Kuru Flow leg + mainnet Nad.fun buy |
| Phase 2: USDC funding | `npm run spike:funding-plan` | plan **simulated on mainnet**; a real signed run needs mainnet USDC |
| Production Privy signer, live trades | `npm run e2e:privy-nadfun` | passed: real Nad.fun buy + sell signed by Privy under policy; over-cap refused, nothing broadcast |
| Privy login path (real app) | `npm run e2e:privy-auth` | passed: embedded-wallet lookup matches; forged/garbage/missing tokens refused |
| Phase 3: Privy policy rejections | `npm run e2e:phase3` | passed (24 refused, 9 allowed, incl. Kuru swaps) |
| Phase 4: mirror, Nad.fun half | `npm run e2e:phase4-nadfun` | passed (3 real wallets) |
| Phase 4: mirror, both venues | `npm run e2e:phase4` | **not run**: needs Perpl testnet AUSD |

The funded scripts need `FUNDER_PRIVATE_KEY` holding MON, plus Perpl's testnet AUSD
(`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`) for anything on Perpl.
