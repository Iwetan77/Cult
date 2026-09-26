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

## Open decisions and blockers

1. **DECISION NEEDED: no Monad-native meme market on Perpl.** The live markets
   endpoint (testnet and mainnet) lists no Monad-native meme perp. `PUMP` is pump.fun's
   Solana token. `MON` is Monad's L1 token, not a meme. The frontend has started a
   `nadfun` (Nad.fun spot) venue to cover memes. Nad.fun is not on the spec's sponsor
   list, so backend has not built it. Product needs to pick: build it, take what Perpl
   lists, or drop the requirement.
2. **DECISION NEEDED: funding path.** Agora's stable swap is KYC-whitelisted
   ("available exclusively to verified platform users through a protected
   whitelist"). On Monad testnet the only pair is `CTK / AUSD`
   (`0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae`). There is no USDC pair on testnet.
   Mainnet has `AUSD / USDC` at `0xf33286E3222D1c829dACeac48c0Ec651F6452470`. The
   frontend's assumptions mention Kuru for funding. **The spec explicitly bans Kuru**,
   so backend has not built it. Until this is decided, a member funds their account
   with testnet AUSD directly (`/v1/perpl/setup` returns `needs_collateral`).
3. **PROVISIONAL: opt-out window is 20 seconds.** It's the backend env var
   `MIRROR_OPT_OUT_SECONDS`, served live at `GET /v1/config` →
   `autoMirrorOptOutWindowSeconds` and on every `ChartSnapshot`. Read it from there.
   Never hard-code it. Product hasn't set the number yet.
4. **Chain.** All trading is on Perpl **testnet (chain 10143)**. The frontend currently
   targets 143 (mainnet) in `.env.local.example`. Use `GET /v1/config → chainId`.
5. **The position cap is enforced by the backend, not by Privy's policy engine.**
   Perpl orders are signed with the member's Ed25519 API key, not sent as wallet
   transactions, so Privy's policy layer never sees an order. Two layers do the
   capping instead:
   - The mirror engine sizes every mirror under the member's `MirrorPolicy`
     (`backend/src/mirror/sizing.ts`).
   - Perpl API keys can never withdraw or transfer out, at any scope. That's Perpl's
     rule, not ours.

   The Privy policy (Phase 3) scopes the wallet transactions the backend may ever
   send on a member's behalf: only Perpl and AUSD, no `withdrawCollateral`, and a
   capped deposit amount.
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
