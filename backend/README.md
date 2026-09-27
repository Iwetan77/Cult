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
npm run preflight        # checks config + every outside service; exit 1 on any FAIL
npm run start:dev        # http://localhost:8787, all routes under /v1 (npm run build && npm start for the compiled one)
```

### Hosting

The backend is a long-running process: one Perpl websocket per member, the Nad.fun
watcher, mirror timers and a SQLite file. So it can't run on serverless platforms
like Vercel; the frontend can. Any Node ≥ 22.5 host with a persistent disk works
(Railway, Render, Fly):

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build | `npm ci --include=dev && npm run build` |
| Start | `npm start` (runs the compiled `dist/`) |
| Health check | `GET /v1/health` |
| Disk | a volume mounted for the DB, with `DB_PATH=/data/cult.db` |
| Env | everything in the table above, plus `NODE_ENV=production`. Set `CORS_ORIGINS` and `PUBLIC_APP_URL` to the frontend's URL, and add that URL to Privy's allowed domains |

Run one instance only: rate limits and mirror timers live in memory, and two
instances would both mirror every trade. `npm run preflight` on the host must show
0 FAIL before traffic goes to it.

Run `npm run preflight` on every new host, and before switching networks. It checks:

- the RPC is on the configured chain;
- the Perpl URLs match that chain, and its exchange and AUSD are deployed there;
- the Nad.fun router and Kuru Flow are there, and fit the memes pay-with setting;
- the Privy credentials work, and the backend's signing key is the one on its Privy
  key quorum;
- dev auth is off, the key-sealing secret is valid and the DB path is writable;
- CORS and the indexer settings are in place.

| Variable | What it's for |
|---|---|
| `PERPL_API_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID` | Perpl network (testnet defaults) |
| `ALCHEMY_MONAD_RPC_URL` | RPC for on-chain reads and writes. Falls back to the public Monad RPC |
| `KEY_ENCRYPTION_SECRET` | 32-byte hex. Seals members' Perpl API-key secrets at rest (AES-256-GCM) |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Verifies Privy access tokens, looks up embedded wallets, creates policies |
| `PRIVY_BACKEND_AUTH_KEY`, `PRIVY_BACKEND_KEY_QUORUM_ID` | The backend's own Privy signer (P-256), added to member wallets under policy |
| `INDEXER_API_KEY` | Shared secret for `/v1/indexer/*` |
| `INDEXER_GRAPHQL_URL` (+ `INDEXER_GRAPHQL_SECRET`) or `INDEXER_PG_URL` (+ `INDEXER_PG_SCHEMA`) | Where member track records come from: the indexer's GraphQL (Hasura, e.g. Envio Cloud), or its Postgres directly when it runs without Hasura. Use a read-only Postgres user. Unset = members show as unverified |
| `MIRROR_OPT_OUT_SECONDS` | Skip window before a mirror fires (provisional: 20) |
| `CORS_ORIGINS`, `PUBLIC_APP_URL` | Frontend origin(s), and the base for share links |
| `NADFUN_PAY_WITH` | `ausd` (swap via Kuru Flow; default on mainnet) or `mon` (default on testnet) |
| `RATE_MEMBER_PER_MIN`, `RATE_TRADE_PER_MIN`, `RATE_PUBLIC_PER_MIN` | Request limits: per member (240), per member on order/tx routes (20), per IP on public routes (120) |
| `LOG_REQUESTS` | One log line per request (method, path, status, ms, member). `0` turns it off |
| `NADFUN_WATCHER_PARALLEL` | Log windows read at once while the meme watcher catches up after downtime (6) |
| `MIRROR_RECONCILE_RECHECK_MS` | After a restart, how often to re-check a send that's still in flight (15000) |
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
