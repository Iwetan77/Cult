# CONTRACTS

Shared contract between the `backend`, `frontend` and `indexer` branches. Types, env
vars, endpoints and cross-branch decisions live here. If you need something from
another branch, add it here instead of editing their folder. Backend keeps this file
current as it builds. Anything marked **PROVISIONAL** can still change. Anything
marked **DECISION NEEDED** is waiting on product.

## Layout

| Area | Path | Owner |
|------|------|-------|
| Backend service (TypeScript/Node, Hono) | `/backend` | `backend` branch |
| Frontend | `/frontend` | `frontend` branch |
| Indexer (Envio HyperIndex) | `/indexer` | `indexer` branch |

Run the backend: `cd backend && cp .env.example .env && npm ci && npm start`. It listens
on `PORT` (default `8787`). All routes are under `/v1`.

## Decisions and blockers

**Venues (decided):** there are two. **Perpl** handles perps (majors). **Nad.fun**
handles Monad-native memes (spot, bonding curve through to DEX). No meme markets are
expected on Perpl. **Kuru** handles USDC→AUSD funding. **Agora is dropped entirely.**
The product owner made these calls in the updated backend brief (2026-09-27).
`00_PROJECT_SPEC.md` still lists the old sponsor set and bans Kuru, so **it needs
updating to match.** Until it is, the brief is what backend follows.

1. **ESCALATED (Spike D): Kuru has no usable AUSD/USDC liquidity, on testnet or
   mainnet.**
   - **Testnet:** Kuru lists 4 markets (`api.testnet.kuru.io/api/v1/markets`):
     cbBTC, WETH, MON and XAUt, all against Kuru's own testnet USDC
     `0xee0722ead54f1b4fe97be399be43bc0226a6f97e`. None involves AUSD. All 4 show 0
     trades in 24h and no last price. `0x8cf49e35…c9cc` has no code on testnet.
   - **Mainnet:** `0x8cf49e35…c9cc` is a Kuru AUSD/USDC order book (base AUSD
     `0x00000000eFE3…`, quote USDC `0x7547…b603`, 0 fees), but `bestBidAsk()` returns
     the empty-book sentinels, so there are no resting orders. The listed mainnet
     AUSD/USDC market shows `liquidity: 0` and 0 trades.

   So the Spike D gate (a real USDC→AUSD swap on testnet) can't be met as written.
   Options:
   - (a) Ask Kuru (hackathon support) to seed a testnet AUSD/USDC book.
   - (b) Seed a small AUSD/USDC book ourselves, which needs both tokens.
   - (c) Run the funding demo on mainnet with real, tiny amounts. That still needs a
     book to trade against.
   - (d) Fund Perpl with testnet AUSD directly for the demo, and keep the Kuru path
     built but unproven.

   Reproduce with `cd backend && npx tsx scripts/spikes/kuru.ts`.
2. **Nad.fun buys are priced per token, not in a single currency (Spike C).** Each
   token trades against its own quote token. On testnet that's mostly MON/WMON and
   LVMON, plus AUSD (Nad.fun's own testnet AUSD `0x2523…C62b`, which is **not**
   Perpl's `0xa901…22dC`), USDC, and tokenized stocks. **Backend only trades
   MON-quoted tokens**, bought with native MON through `buyWithNative`. It never
   swaps between quote assets. The frontend should filter the token list the same
   way.
3. **PROVISIONAL: opt-out window is 20 seconds.** It's the backend env var
   `MIRROR_OPT_OUT_SECONDS`, served live at `GET /v1/config` →
   `autoMirrorOptOutWindowSeconds` and on every `ChartSnapshot`. Read it from there.
   Never hard-code it. Product hasn't set the number yet.
4. **Chain.** All trading is on Perpl **testnet (chain 10143)**. The frontend currently
   targets 143 (mainnet) in `.env.local.example`. Use `GET /v1/config → chainId`.
5. **Where the per-trade cap is enforced differs by venue.**
   - **Perpl:** orders are signed with the member's Ed25519 API key, not sent as wallet
     transactions, so Privy's policy layer never sees them. The mirror engine sizes
     every Perpl mirror under the member's `MirrorPolicy`
     (`backend/src/mirror/sizing.ts`). Perpl API keys can never withdraw at any scope.
   - **Nad.fun:** every buy and sell is a wallet transaction, so Privy's policy is the
     real per-trade cap. It allows only the Nad.fun router, requires the
     tokens/proceeds recipient `to` to be the member's own wallet, and caps the MON
     `value` per buy.

   Across both venues, the Privy policy scopes every wallet transaction the backend
   may send: Perpl exchange + AUSD approve + Nad.fun router only. No
   `withdrawCollateral`, no transfers out, capped amounts.
6. **Perpl enrollment `Origin`.** Server-side enrollment works on testnet with no
   `Origin` header. Browser-side enrollment needs Perpl to whitelist our domain.
   Enrollment runs server-side, so this isn't blocking.

## Network constants (Perpl testnet, verified live)

Read at runtime from `GET https://testnet.perpl.xyz/api/v1/pub/context`. The values
below are for reference only.

| Key | Value |
|-----|-------|
| Chain ID | `10143` (Monad testnet) |
| Perpl REST | `https://testnet.perpl.xyz/api` |
| Perpl WS | `wss://testnet.perpl.xyz` |
| Exchange contract | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |
| Collateral | AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`, 6 decimals |
| Min account open | 100 AUSD (raw `100000000`). Mainnet is 10 AUSD. |
| Min deposit | 10 AUSD |
| Min order value | 0 (`getMinimumPostCNS` / `getMinimumSettleCNS` both 0 on testnet) |

Perpl's api-docs `.env.example` still lists the old testnet collateral (`0xdf5b…`,
"Test USD"). That's stale. Use `0xa9012a…`.

### Markets (testnet): what the live API returns

| id | symbol | max lev | maker bps | taker bps |
|----|--------|---------|-----------|-----------|
| 16 | BTC | 6.67x | 0.45 | 3.45 |
| 32 | ETH | 8.33x | 0.45 | 3.45 |
| 48 | SOL | 10x | 0.45 | 3.45 |
| 64 | MON | 33.3x | 0.45 | 3.45 |
| 256 | ZEC | 33.3x | 0.45 | 3.45 |
| 272 | LIT | 33.3x | 0.45 | 3.45 |
| 320 | PUMP | 20x | 0.45 | 3.45 |

Mainnet has BTC(1), MON(10), ETH(20), SOL(31), HYPE(40), ZEC(50), LIT(60), VVV(70) and
PUMP(90). Reproduce with `cd backend && npm run spike:markets`.

### Fees and funding

- **Fees:** in micros per market and per tier (`Account.ft`). The current schedule
  on every market is maker `[45,25,15,0,…]` and taker `[345,300,250,210,175,150,125,0]`,
  which is 0.45 / 3.45 bps at the base tier. Tiers come from rolling 14-day volume.
  A fee is charged on every fill that changes position size, closes included.
- **Funding:** one funding event every 8571 blocks (`funding_interval_sec` 2580, about
  43 minutes). The rate is in micros and clamped on-chain. A positive rate means
  longs pay shorts.

## How delegated trading works (Phase 0 spike B)

1. The member's wallet opens a Perpl account on-chain with `createAccount(amount)`
   after an AUSD `approve`.
2. The backend generates an Ed25519 keypair. The member's wallet signs Perpl's
   EIP-712 enrollment payload once, and the backend adds the proof-of-possession. The
   backend keeps the private key, sealed with AES-256-GCM. The key's scope is
   `trade`: it can place and cancel orders but can **never withdraw or transfer out**.
3. The member's wallet calls `allowOrderForwarding(true)`, so Perpl accepts API
   orders for the account.
4. From then on, the backend trades the account over `wss://…/ws/v1/trading` with that
   key. Perpl caps trading WebSockets at 4 per wallet, and a key can only trade its own
   wallet's account, so the backend holds one session per member.

Perpl also publishes an on-chain owner/operator contract,
[PerplFoundation/delegated-account](https://github.com/PerplFoundation/delegated-account)
(testnet factory `0xf42548Ccb3300Bc76c35dc2D347416db2E8d7209`). We don't need it,
because an API key already separates trading from withdrawal. It's there as a fallback.

## Nad.fun (Spike C): confirmed integration surface

Source: [Naddotfun/nadfun-v2-intergration](https://github.com/Naddotfun/nadfun-v2-intergration)
(ABIs + docs, marked "Monad Testnet: Available"), cross-checked on-chain and against the
testnet API. There's no REST trading API. Buys and sells are **direct contract calls from
the member's wallet**. The API is read-only (token lists, charts, swap history).

| | Testnet (10143) | Mainnet (143) |
|---|---|---|
| `NadFunRouter` (the only contract we call) | `0x75588668999cA0557b78046b8a5E86b47b9234ec` | `0x8986C8fD44eb85294A725a7e61AF35E76bA26F91` |
| `BondingCurve` | `0x27063a38eC0D3281D354090EB92e669Ed1eB956C` | `0x9f3832732923252A21044F21eE6bd87F09514ae4` |
| `NadFunFactory` (DEX pairs) | `0x59C51c66B79c68F63d5446940CD13b6968788e36` | `0xA25b13127e63ddae6d0b35570FF3D39dBD621001` |
| WMON | `0x5a4E0bFDeF88C9032CB4d24338C5EB3d3870BfDd` | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` |
| Deploy block (curve) | `30418615` | `73857231` |
| Read API | `https://dev-api.nadapp.net` | `https://api.nad.fun` |

The testnet API lists 412 tokens (`/order/latest_trade`, `/order/market_cap`,
`/order/creation_time`, `/token/:addr`, `/trade/market/:addr`, `/trade/chart/:addr`,
`/trade/swap-history/:addr`). `router.getAmountOut(token, 0.01 MON, true)` returns
live quotes today. Reproduce with `npx tsx scripts/spikes/nadfun.ts`.

**Trading calls (router):**

- `buyWithNative((amountOutMin, token, to, deadline))`: payable. `msg.value` is the MON
  spent.
- `sellToNative((amountIn, amountOutMin, token, to, deadline))`: pays out MON. It needs
  `token.approve(router, amountIn)` first.
- `getAmountOut(token, amountIn, isBuy)` / `getAmountIn(...)`: lifecycle-aware quotes.
- `isGraduated(token)`: true once the token has moved from the curve to its DEX pair.

The router picks the bonding curve before graduation and the DEX pair after, so the
caller never has to.

**Events for the indexer.** Index the **router**: it emits on both the curve and
DEX paths, with the trader as `buyer`/`seller`.

```solidity
// NadFunRouter
event Buy (address indexed buyer,  address indexed token, uint256 amountIn, uint256 amountOut, bool graduated); // amountIn = quote (MON wei), amountOut = tokens
event Sell(address indexed seller, address indexed token, uint256 amountIn, uint256 amountOut, bool graduated); // amountIn = tokens, amountOut = quote (MON wei)
event Create(address indexed token, address indexed creator);
// BondingCurve (curve-only detail, optional)
event Buy (address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokenOut);
event Sell(address indexed token, address indexed seller, uint256 tokenIn, uint256 quoteOut);
event Create(address indexed creator, address indexed token, address indexed pair, address quoteToken, string name, string symbol, string tokenURI, uint256 virtualQuoteReserve, uint256 virtualTokenReserve, uint256 minTokenReserve);
event Graduate(address indexed token, address indexed pair);
```

**How buys and sells map to cost basis and PnL.** Use average cost per
`(wallet, token)`, in the token's quote asset (MON for everything Cult trades):

- **On `Buy`:** `qty += amountOut`, `cost += amountIn`.
- **On `Sell`:** `realized += amountOut - cost * (amountIn / qty)`, then
  `cost -= cost * (amountIn / qty)` and `qty -= amountIn`.

A "trade" is the round trip from the first buy (qty 0 → >0) back to qty 0. A win means
realized > 0. Values are in MON. Converting to USD needs a MON price at the event's
time, which the indexer should record rather than guess. Token transfers in and out
of a wallet (not via the router) change qty without a price. Treat them as
zero-cost-basis and flag them.

---

## Backend HTTP API

### Auth

- **Members:** `Authorization: Bearer <Privy access token>`. The backend verifies it
  against Privy's JWKS for `PRIVY_APP_ID` and resolves the user's Privy embedded
  Ethereum wallet. A user with no embedded wallet gets `409`.
- **Indexer:** `X-Indexer-Key: <INDEXER_API_KEY>`, server-to-server only.
- **Errors:** always `{ "message": string, "issues"?: ZodIssue[] }` with a 4xx or 5xx
  status.

### Types

```ts
type MirrorPolicy = {
  enabled: boolean;          // false = member is in the clan but never auto-mirrored
  balancePercentCap: number; // (0, 100]  max % of free Perpl balance ONE mirror may use as margin
  maxUsdPerTrade: number;    // [1, 1e6]  max notional (size x mark, USD) of ONE mirrored position
};

type Market = {
  venue: 'perpl'; id: string /* Perpl market id */; symbol: string /* "BTC-PERP" */;
  baseSymbol: string; quoteSymbol: 'USD'; maxLeverage: number; makerFeeBps: number; takerFeeBps: number;
};

type Clan = { id: string; name: string; inviteCode: string; memberCount: number; myPolicy: MirrorPolicy | null };

type ChartMarker = {
  id: string;            // "trade:<id>" | "mirror:<id>" | "stack:<id>"
  tradeId: string;       // the leader trade this marker hangs off (stack target for manual_stack)
  memberId: string; memberName: string;
  marketId: string; venue: 'perpl';
  origin: 'leader' | 'auto_mirror' | 'manual_stack';
  side: 'long' | 'short';
  entryTime: number;     // ms
  entryPrice: number | null; markPrice: number;
  size: number | null; pnlUsd: number | null; valueUsd: number | null; leverage: number | null;
  isMine: boolean;
  mirrorStatus?: 'pending' | 'submitted' | 'filled';   // auto_mirror only
  skipUntil?: string;    // ISO, only while pending. Backend enforces it; the UI clock is a guide
  txHash?: string | null;
};

type ChartSnapshot = {
  clan: Clan; markets: Market[]; selectedMarket: Market;
  candles: { time: number /* unix s */; open: number; high: number; low: number; close: number }[];
  markers: ChartMarker[];
  members: { id: string; name: string; address: string; winRate: null; realizedPnlUsd: null; tradeCount: number; verified: false }[];
  asOf: string; autoMirrorOptOutWindowSeconds: number;
};

type WalletAction = { to: string; data: string; value?: string; chainId: number; label: string };
```

Price PnL on markers is `(mark - entry) x size` against Perpl's live mark. It
excludes the closing fee and unsettled funding. `winRate` and `realizedPnlUsd` are
always `null` from the backend. Verified track record comes from the indexer.

### Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/v1/health` | none | `{ ok: true }` |
| GET | `/v1/config` | none | `{ chainId, venue, autoMirrorOptOutWindowSeconds, mirrorPolicyBounds, markets: Market[] }` |
| GET | `/v1/me` | none | `{ id, address, name, clans: Clan[], perpl: { accountId, keyEnrolled, forwarding }, usdcBalance: null }` |
| GET | `/v1/privy/signer` | none | `{ signerId, policyIds: string[], capUsd }`. `409` until the member is in a clan |
| GET | `/v1/perpl/setup?depositRaw=` | none | `SetupStatus` (below) |
| POST | `/v1/enrollment/perpl/challenge` | none | `{ challengeId, typedData, expiresAt }` |
| POST | `/v1/enrollment/perpl` | `{ challengeId, signature }` | `204` |
| POST | `/v1/clans` | `{ name, policy: MirrorPolicy }` | `201 Clan` |
| POST | `/v1/clans/join/challenge` | `{ inviteCode, policy: MirrorPolicy }` | `{ challengeId, message }` |
| POST | `/v1/clans/join` | `{ challengeId, signature }` | `Clan` |
| GET | `/v1/clans/:clanId/chart?marketId=&resolution=` | none | `ChartSnapshot` |
| GET | `/v1/clans/:clanId/events` | none | SSE stream (below) |
| POST | `/v1/clans/:clanId/mirrors/:mirrorId/skip` | none | `204`. `409` if not pending or the window has passed |
| POST | `/v1/clans/:clanId/stack` | `{ markerId, notionalUsd, leverage? }` | `StackResult` |
| GET | `/v1/positions` | none | `{ positions: PositionView[] }` |
| POST | `/v1/positions/open` | `{ marketId, side, marginUsd, leverage }` | `{ orderId, requestId, filledSize, fillPrice, txHash }` |
| POST | `/v1/positions/close` | `{ marketId }` | same as open |

Notes:

- **Perpl setup is a loop.** `GET /v1/perpl/setup` returns
  `{ step, wallet, perplAccountId, collateralBalance, minAccountOpen, actions: WalletAction[] }`,
  where `step` is one of `needs_collateral`, `needs_account`, `needs_key`,
  `needs_forwarding` or `ready`. Send `actions` in order from the member's Privy
  wallet, then call it again. On `needs_key`, run the enrollment challenge: sign
  `typedData` with `eth_signTypedData_v4`, exactly as returned, then POST the
  signature. The backend completes the Perpl enrollment.
- **Backend signer.** After the member joins or creates a clan, call
  `GET /v1/privy/signer`, then Privy's
  `useSigners().addSigners({ address, signers: [{ signerId, policyIds }] })`. This
  lets the backend send the Perpl setup transactions for the member, but only
  within Privy's policy: Perpl exchange and AUSD only, no withdrawals, no transfers
  out, no MON value, and at most `capUsd` per deposit or approve. `capUsd` follows
  the member's largest `maxUsdPerTrade`. Without the signer, the member's wallet
  sends the setup actions itself. That path works too.
- **Joining a clan** is standing consent. The challenge `message` spells out the
  policy in plain words. The member signs it with `personal_sign`, and the backend
  checks the signer is their wallet and stores the signed text. It is never re-asked
  per trade.
- **`positions/open` is the member's own trade.** It becomes a `leader` marker and
  clan-mates get auto-mirrored.
- **`stack` is the manual path.** `markerId` is any `ChartMarker.id` (or a bare trade
  id). It opens `notionalUsd` of the same side on the caller's own account and is
  never auto-mirrored. It doesn't auto-close when the target closes. `StackResult`
  is `{ id, status: 'open' | 'failed', marketId, side, size, notionalUsd, leverage, orderId?, txHash?, error? }`.
  Status `502` means Perpl refused the order, and `error` says why.
- **`frontend/src/lib/api.ts` assumed a quote-then-confirm stack flow with a wallet
  transaction.** That doesn't apply on Perpl, where orders go through the API key.
  Use the single `POST /stack` above.

### Examples (captured from `npx tsx scripts/smoke-api.ts`)

```http
POST /v1/clans
{"name":"night shift","policy":{"enabled":true,"balancePercentCap":25,"maxUsdPerTrade":200}}
→ 201
{"id":"64334b99-45e3-41d8-8f1c-80f11e79df6a","name":"night shift","inviteCode":"jDvLxUuh","memberCount":1,
 "myPolicy":{"enabled":true,"balancePercentCap":25,"maxUsdPerTrade":200}}
```

```http
POST /v1/clans/join/challenge
{"inviteCode":"jDvLxUuh","policy":{"enabled":true,"balancePercentCap":10,"maxUsdPerTrade":50}}
→ 200
{"challengeId":"af2718b9-…","message":"Join Cult clan \"night shift\" (jDvLxUuh)\nWallet: 0x501d…0D12\n\nWhen any member of this clan opens a Perpl position, open a mirrored position on my account automatically.\nMax margin per mirror: 10% of my free Perpl balance.\nMax position size per mirror: $50.\nWhen the original position closes, close my mirror too.\nI can skip any single trade before it fires. The backend can never withdraw my funds.\n\nNonce: af2718b9-…"}

POST /v1/clans/join
{"challengeId":"af2718b9-…","signature":"0x21af…1c"}
→ 200 {"id":"64334b99-…","name":"night shift","inviteCode":"jDvLxUuh","memberCount":2,"myPolicy":{"enabled":true,"balancePercentCap":10,"maxUsdPerTrade":50}}
(signature from any other wallet → 403 {"message":"signature is not from your wallet"})
```

```http
POST /v1/clans   policy {"balancePercentCap":150,"maxUsdPerTrade":0}
→ 400 {"message":"invalid request","issues":[{"path":["policy","balancePercentCap"],"message":"Too big: expected number to be <=100",…},
                                            {"path":["policy","maxUsdPerTrade"],"message":"Too small: expected number to be >=1",…}]}
```

```http
GET /v1/perpl/setup          (fresh wallet, no AUSD yet)
→ 200 {"wallet":"0x501d…0d12","perplAccountId":null,"collateralBalance":"0","minAccountOpen":"100000000","step":"needs_collateral","actions":[]}
```

```jsonc
// GET /v1/clans/:id/chart?marketId=16 → one leader trade with a pending mirror (shape)
{
  "clan": { "id": "…", "name": "night shift", "inviteCode": "jDvLxUuh", "memberCount": 2, "myPolicy": { … } },
  "markets": [{ "venue": "perpl", "id": "16", "symbol": "BTC-PERP", "baseSymbol": "BTC", "quoteSymbol": "USD", "maxLeverage": 6.66, "makerFeeBps": 0.45, "takerFeeBps": 3.45 }, …],
  "selectedMarket": { "id": "16", … },
  "candles": [{ "time": 1790463120, "open": 84320, "high": 84347.4, "low": 84320, "close": 84335 }, …],
  "markers": [
    { "id": "trade:9c1…", "tradeId": "9c1…", "memberId": "did:privy:…", "memberName": "0x3582…c063", "marketId": "16", "venue": "perpl",
      "origin": "leader", "side": "long", "entryTime": 1790466000000, "entryPrice": 84395.1, "markPrice": 84410, "size": 0.0007,
      "pnlUsd": 0.0104, "valueUsd": 59.09, "leverage": 3, "isMine": false, "txHash": "0x…" },
    { "id": "mirror:4be…", "tradeId": "9c1…", "memberId": "did:privy:…", "memberName": "0x501d…0d12", "marketId": "16", "venue": "perpl",
      "origin": "auto_mirror", "side": "long", "entryTime": 1790466000500, "entryPrice": null, "markPrice": 84410, "size": null,
      "pnlUsd": null, "valueUsd": null, "leverage": null, "isMine": true, "mirrorStatus": "pending", "skipUntil": "2026-09-27T01:00:20.500Z" }
  ],
  "members": [{ "id": "did:privy:…", "name": "0x3582…c063", "address": "0x3582…", "winRate": null, "realizedPnlUsd": null, "tradeCount": 0, "verified": false }, …],
  "asOf": "2026-09-27T01:00:05.000Z",
  "autoMirrorOptOutWindowSeconds": 20
}
```

The chart example is a **shape illustration**, not captured output. Real captured
chart payloads will replace it after the Phase 4 run on funded wallets.

### SSE: `GET /v1/clans/:clanId/events`

`text/event-stream`, authenticated like the other routes. Events:

| event | data |
|-------|------|
| `trade` | a new leader trade in this clan: `{ id, userId, accountId, marketId, side, positionId, size, entryPrice, leverage, marginFraction, openTx, openedAt, closedAt: null }` |
| `trade_closed` | same shape, `closedAt` set |
| `mirror` | a mirror changed: `{ id, tradeId, clanId, userId, status, skipUntil, marginUsd, notionalUsd, size, capApplied, openOid, openTx, closeOid, closeTx, error, … }` |
| `ping` | every 15s |

Mirror `status` goes `pending → skipped | submitting → open → closed`. It can also
end in `failed` or `cancelled`, where `cancelled` means the leader closed before the
mirror fired. On any event, re-fetch `/chart` or patch the marker locally. Browser
`EventSource` can't send headers, so fetch the stream with the `Authorization` header
(for example `@microsoft/fetch-event-source`).

## Indexer API (correlating chain events with clans)

All routes need `X-Indexer-Key`.

| Method | Path | Returns |
|--------|------|---------|
| GET | `/v1/indexer/accounts` | `{ accounts: [{ userId, wallet, perplAccountId, clanIds: string[] }] }` |
| GET | `/v1/indexer/orders?since=<ms>` | `{ orders: [{ perplAccountId, requestId, kind: 'mirror_open' \| 'mirror_close' \| 'stack_open', refId, clanId, tradeId, createdAt }] }` |
| GET | `/v1/indexer/trades?since=<ms>` | `{ trades: [{ tradeId, userId, perplAccountId, marketId, side, positionId, openTx, openedAt, closedAt }] }` |

**How to correlate.** Perpl's `OrderRequest(perpId, accountId, orderDescId, orderId, …)`
event carries `orderDescId`, which is our `requestId`:

- A fill whose `(accountId, orderDescId)` appears in `/orders` came from the auto-mirror
  engine or a manual stack.
- Anything else on a clan member's account is their own trade.

Map `accountId` to member and clans through `/accounts`. Page with `since` (the
`createdAt` of the last row seen), 1000 rows max per page.

## Backend env vars

See `backend/.env.example`. Frontend and indexer only need to know:

- `PORT` (default 8787), `CORS_ORIGINS` (comma-separated, default `http://localhost:3000`).
- `INDEXER_API_KEY`: shared with the indexer out of band. Never commit it.
- `MIRROR_OPT_OUT_SECONDS`: see decision 3. Read it from `/v1/config`.
