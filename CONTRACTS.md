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

## Where this file lives, and who edits what

- **This file on the `backend` branch is the canonical copy until `main` exists.** Read
  it with `git fetch origin && git show origin/backend:CONTRACTS.md`.
- Don't keep a divergent full copy on another branch, because it will conflict at
  merge. Put your branch's own published shapes in your own folder, and this file
  links to them:
  - Indexer read API: `indexer/API.md`
  - Frontend-only assumptions: `frontend/CONTRACT_ASSUMPTIONS.md`

## Product decisions (2026-09-27, from the product owner)

1. **The app shows dollars ($) everywhere. The word "AUSD" appears only on the funding
   screen.** (Corrected 2026-09-27: an earlier version of this line wrongly said to
   display AUSD everywhere.)
   - Balances, PnL, prices, caps, markers and share cards all show `$`.
   - Under the hood everything settles in AUSD 1:1 with the dollar, and Nad.fun values
     (natively MON) are converted to dollars at the MON price the backend serves.
   - API fields ending in `Ausd` or `Usd` are all dollar amounts; render them as `$`.
     The names stay as they are so nothing breaks.
   - `quoteSymbol` on markets and `displayUnit` in `/v1/config` are `'USD'`.
2. **Funding has two options:**
   - Deposit **AUSD directly**.
   - Pay with **USDC**, which the backend routes through **Kuru Flow** (Kuru's router)
     to AUSD, on mainnet. There's real liquidity: Kuru routes through a ~$1.5M
     AUSD/USDC stable pool, and $25 simulated on mainnet returns $25.004. The member
     signs the plan in the browser, and can send the AUSD straight into Perpl
     (perps) or keep it in the wallet (memes).
3. **Gate status.**
   - **Passed with real transactions:**
     - Spike C: a real Nad.fun buy and sell.
     - Phase 3: Privy's policy engine, 24 refusals and 9 allows, Kuru swaps included.
     - **The production signing path, live on testnet:** the backend's own Privy signer,
       attached to a Privy wallet under that member's policy:
       - made a real Nad.fun buy (`0xf9412214…f79e`) and sell (`0xaabb8204…371e`),
         signed by Privy and broadcast by the backend;
       - had an over-cap buy refused by Privy with nothing broadcast.

       The member's own key then swept the leftovers, since the owner isn't bound by
       the policy. Run it with `npm run e2e:privy-nadfun`.
     - **Phase 4, Nad.fun half, on the production signing path:** B and C are real
       Privy wallets, with the backend signer attached via `memberSignerGrant` under
       each member's policy, and no test keys. A's own buy was mirrored for B and C
       through Privy (C clamped by `balancePercentCap`), and A's sell made both exit to
       0 on-chain. Privy confirmed each signer attached and current, and lowering B's cap
       made that policy outdated. Run it with `npm run e2e:phase4-nadfun-privy`.
       **Re-run with adds and partial sells (2026-09-27), all through Privy:**
       - A bought (`0xf5f3daa7…4ea2`); B and C mirrored (`0x12a492bb…b242`,
         `0x5b50e7f0…0443`).
       - A sold half (`0xd68f1648…6296`), and B and C each sold exactly half of their
         mirror at once (`0xdb09d2d1…e623`, `0x2425b596…855f`); their balances match
         the mirror sizes to the wei.
       - A bought more (`0x9bca95cd…951a`, ratio 2.0), and after the skip window B
         and C added their share (`0x6de0c8fe…d613`, `0x45a29b94…1973`).
       - A exited (`0x0cc474fb…3e3c`), and B and C sold out to 0 (`0x65c29de4…ac3d`,
         `0x90815541…82bd4`).
     - The Privy login path against the real app: the embedded-wallet lookup matches,
       and forged, garbage and missing tokens are refused (`npm run e2e:privy-auth`).
     - Kuru Flow swaps and the USDC funding plan, **simulated on mainnet**: real
       routes and real calldata executed via `eth_call` with balance overrides. No
       money is spent; the swap output must meet the guaranteed minimum.
     - The **Nad.fun half of Phase 4**: 3 fresh testnet wallets. A's own buy was picked
       up by the router watcher, B and C mirrored from their own MON (C clamped by
       `balancePercentCap`), and A's full exit made B and C sell out to a 0 balance
       on-chain. Run it with `npm run e2e:phase4-nadfun`.
       It was re-run after the dollar-share sizing fix (2026-09-27) with 3 new wallets.
       Leader A `0x078aB3aE426a7c21449d80dBB81E1f1b140275C9` bought in
       `0x57b53833…4a3e` and sold in `0x79a8dc24…65d9`. B mirrored (buy
       `0xbb7d3619…5c44`, sell `0x2fc29671…88b2`), and C mirrored clamped by
       `balancePercentCap` (buy `0x41bf67db…ec7`, sell `0x1e7b82c2…4030`).
   - **Deferred, needing Perpl testnet AUSD or mainnet USDC:** these are marked "not run",
     never "passed". The product owner has no testnet or
   mainnet funds right now, so the affected gates will be run later:
   - Spike B (Perpl order via delegated key)
   - Phase 1 (both venues end to end)
   - Phase 2 (Kuru funding)
   - Phase 4 (multi-account mirror)

   Build against this contract meanwhile. Nothing is faked: a gate is either
   "passed" with tx hashes or "not run".
4. **Memes are paid in dollars (product decision (b)).** Nad.fun tokens are priced in
   MON (160 of 168 sampled mainnet tokens; none in AUSD). So on mainnet, a meme buy:
   - swaps exactly the dollar amount of the member's **wallet** AUSD to MON on Kuru
     Flow, then buys the token with the MON that arrived;
   - a sale swaps exactly the sale's MON back to AUSD.

   Members still keep a little MON for gas; 0.25 MON is never spent. On Monad, gas is charged on the whole gas limit: a Nad.fun sell alone is about 0.055 MON on testnet. A member's
   dollars sit in two places: **Perpl margin** (perps) and **wallet AUSD** (memes).
   The backend reports both. Testnet has no Kuru Flow, so there meme buys spend MON
   directly (`NADFUN_PAY_WITH=mon`). Cult only trades MON-quoted Nad.fun tokens.
5. **Manual stack works the same on both venues:** `POST /v1/clans/:clanId/stack`, and
   the backend executes it. On Nad.fun it's signed through the member's Privy wallet by
   the backend signer, under Privy policy. There's no quote/confirm step and no wallet
   popup. This needs the backend signer added to the member's wallet at clan-join (see
   `GET /v1/privy/signer`), which is **required**, because Nad.fun mirrors are wallet
   transactions.
6. **A leader's adds and partial sells are mirrored too** (2026-09-27), on both venues.
   Clans have a **group chat**, and leaders are expected to say what they're about to do
   there first.
   - **Partial sell:** the leader sells X% of a trade → every open mirror sells X% of
     itself, **straight away** (no skip window; it only takes risk off, like an exit).
   - **Add:** the leader grows a trade by X% → every open mirror adds X% of itself
     **after the usual skip window**, capped like a new mirror (`maxUsdPerTrade` per add,
     `balancePercentCap` of what's free). The member can skip it (`pendingAdd` on their
     marker).
   - A leader selling down to under 1% of the trade counts as the exit.
   - Only mirrors follow. Manual stacks stay manual.
7. **The groups are called Cults** (2026-09-27). Say "cult" everywhere in the UI.
   - **API names:** every route answers under `/v1/cults/...`, and the older
     `/v1/clans/...` still works (same handlers). JSON field names keep `clan`
     (`clanId`, `clans`) so nothing breaks.
   - **Join codes** are six letters shown as `ABC-DEF`. Joining forgives case, spaces
     and a missing dash.
   - **Public cults:** created with `visibility: 'public'`, or the owner flips one.
     They're listed in discover and on the cults leaderboard, and anyone can join
     them by id. Joining still needs the signed consent. Private cults are code-only.
   - **Like a fantasy league**, everyone is in the **Global** chat and leaderboard.
     Picking a country (ISO code) adds its **country** chat and leaderboard. Each cult
     has its own chat and leaderboard too.
   - **Leaderboards rank own trades only:** verified realized PnL in $, then win rate,
     then trade count. Copies don't count. Only members with a verified closed trade
     get a rank, and everyone still sees their own row. They're all-time for now.
8. **Social flow** (2026-09-27, the product owner's redesign).
   - **Signing in** lands you in **Global**, and in your country once you pick it.
     Nobody is forced to create or join a cult.
   - **Joining a cult is one tap:** `{ inviteCode }` or `{ cultId }`, no signature,
     copying **off**. Creating one takes just a name (plus visibility).
   - **Copying is an Auto-follow switch per cult.**
     - **On:** the member signs their limits once, with `/policy/challenge` then
       `/policy`, using `enabled: true`. The suggestions come from
       `/v1/config.autoFollowDefaults`.
     - **Off:** instant, with no signature.
   - **Chats double as the activity feed:**
     - "X joined the cult / Cult / your country", "turned on Auto-follow";
     - members' trades: "opened BTC-PERP long 5x", "sold 50% of $MOE",
       "closed …", each linking to its chart marker.

     Global and country rooms have a pinned welcome, and a cult owner can pin a
     message.
   - **Home:** the week's top trades across Cult, with "N traders were in", plus your
     7 days. **Profiles:** record (win rate, streak, average win %), open and closed
     trades.

## Decisions and blockers

**Venues (decided):** there are two. **Perpl** handles perps (majors). **Nad.fun**
handles Monad-native memes (spot, bonding curve through to DEX). No meme markets are
expected on Perpl. **Kuru** handles USDC→AUSD funding. **Agora is dropped entirely.**
The product owner made these calls in the updated backend brief (2026-09-27).
`00_PROJECT_SPEC.md` still lists the old sponsor set and bans Kuru, so **it needs
updating to match.** Until it is, the brief is what backend follows.

1. **Kuru: corrected. The liquidity is there.** Earlier this file said Kuru had no
   AUSD liquidity. That was wrong: it only checked Kuru's own (empty) AUSD/USDC order
   book `0x8cf49e35…`. **Kuru Flow** (`https://ws.kuru.io`, router `KuruFlowEntrypoint`
   `0xb3e6778480b2E488385E8205eA05E20060B813cb`) routes across Monad mainnet
   liquidity, including a Curve-style AUSD/USDC pool `0x9426…9ea91ab` holding about
   870k AUSD and 713k USDC. Live results:
   - 100 USDC → 100.015 AUSD
   - $10 AUSD → ~381 MON
   - 100 MON → $2.62

   Every quote is checked before signing:
   - the target must be Kuru's router;
   - the function must be `executeSwap`, which pays the caller (never
     `executeSwapWithReceiver`);
   - the intent must match what was asked for;
   - both fees must be 0.

   Reproduce with `npm run spike:kuru-flow` and `npm run spike:funding-plan`. Kuru
   Flow is mainnet-only.
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

**Spike C gate: passed on testnet (2026-09-27).** A fresh wallet `0xBdd5…A98A` did
the following on token TTT `0x5e2E…7777` (still on the bonding curve):

- Buy `0xe69e2841…8375`: 0.01 MON → 148.4796 TTT.
- Approve `0x24b123f4…7767`.
- Sell `0xf5917761…06a8`: 148.4796 TTT → 0.009604 MON.

The token balance went 0 → 148.48 → 0. Both trades appear in Nad.fun's own
`/trade/swap-history`. **A round trip on the curve cost about 4%** (fees plus curve
spread at this size). The mirror sizing and the UI should expect that. Reproduce with
`npm run spike:nadfun-trade`.

**Indexer validation target (real, available now).** Wallet
`0xBdd51F3CBCC4890635c75453c93f8aB4C3e0A98A` made exactly one round trip on TTT
`0x5e2E014020f31A410cC6Cd44dEfb646b02467777`:

- A buy of 0.01 MON for 148.4796392128505102 TTT in
  `0xe69e2841f2e53076eef897230f18ead60c4edbbbaf8f3e26e9768dbe276c8375`.
- A sell of all 148.4796392128505102 TTT for 0.009604 MON in
  `0xf591776147428b1440ffd8c00883e6514f09391d1cbeee1eb64ff7512f9d06a8`.

The expected result is **1 closed trade, 0 wins, realized −0.000396 MON**. You can check
it against Nad.fun's own
`https://dev-api.nadapp.net/trade/swap-history/0x5e2E014020f31A410cC6Cd44dEfb646b02467777`.
The router proxy was deployed around block `30418626` (the curve at `30418615`).

More real round trips on TTT from the Phase 4 Nad.fun gate, all around blocks
66006900–66007000. Each is 1 closed trade and 0 wins, and all were checked against
Nad.fun's API:

| wallet | role | realized |
|---|---|---|
| `0xc4f8c5724313e74759e572065453e7C52C5EC185` | leader A | −0.003960 MON |
| `0xC434777485d8f4e8A4f6e93A2aCE32155C84eF13` | auto-mirror B | −0.003630 MON |
| `0x6222DDA40a6d550b703D0CE62f5bAb17FB7907EE` | auto-mirror C | −0.001089 MON |

B's and C's buys are auto-mirrors, so their tx hashes appear in backend
`/v1/indexer/txs` as `mirror_open` / `mirror_close`. That makes them the test case for
labelling a trade as auto-mirrored rather than the member's own.

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
  status. A `503` means an upstream (Perpl, Nad.fun, Kuru, RPC) is unreachable; retry
  after a moment.

### Types

```ts
type MirrorPolicy = {
  enabled: boolean;          // false = member is in the clan but never auto-mirrored
  balancePercentCap: number; // (0, 100]  max % of the free balance on that venue ONE mirror may use
                             //           (perpl: free margin; nadfun: wallet AUSD, or MON minus a 0.25 MON gas reserve)
  maxUsdPerTrade: number;    // [1, 1e6]  max size of ONE mirror in $
                             //           (perpl: notional = size x mark; nadfun: MON spent, valued in $)
};
// Every *Usd / *Ausd field is a dollar amount; show it as $. (It settles in AUSD
// 1:1 under the hood; users only see the word AUSD when funding.)

type Venue = 'perpl' | 'nadfun';
type TradeSide = 'long' | 'short' | 'buy';   // nadfun is always 'buy' (spot)

type Market = {
  venue: Venue;
  id: string;            // perpl: market id ("16"); nadfun: token address (lowercase 0x…)
  symbol: string;        // "BTC-PERP" | token symbol
  baseSymbol: string; quoteSymbol: 'USD';
  maxLeverage: number;   // nadfun: 1
  makerFeeBps: number | null; takerFeeBps: number | null;   // nadfun: null
  tokenAddress?: string; imageUri?: string;                 // nadfun only
};
// A marketId is either kind. Tell them apart with /^0x[0-9a-fA-F]{40}$/ (nadfun).

type Clan = {                        // a Cult
  id: string; name: string;
  inviteCode: string;                 // ABC-DEF (older cults may show a legacy code)
  visibility: 'private' | 'public';
  isOwner: boolean;                   // only the owner can change visibility or pin
  memberCount: number; myPolicy: MirrorPolicy | null;
  autoFollow: boolean;                // = myPolicy.enabled; the switch in the cult's side panel
};

type ChartMarker = {
  id: string;            // "trade:<id>" | "mirror:<id>" | "stack:<id>"
  tradeId: string;       // the leader trade this marker hangs off (stack target for manual_stack)
  memberId: string; memberName: string;
  marketId: string; venue: Venue;
  origin: 'leader' | 'auto_mirror' | 'manual_stack';
  side: TradeSide;
  entryTime: number;     // ms
  entryPrice: number | null; markPrice: number;   // $ per unit (per token for nadfun)
  size: number | null;   // base units (perpl) / tokens (nadfun)
  pnlUsd: number | null; valueUsd: number | null; // $. nadfun value = what selling that amount returns now
  leverage: number | null;                        // nadfun: 1
  isMine: boolean;
  mirrorStatus?: 'pending' | 'submitted' | 'filled';   // auto_mirror only
  skipUntil?: string;    // ISO, only while pending. Backend enforces it; the UI clock is a guide
  pendingAdd?: {         // auto_mirror only: the leader added, and this mirror will add the same share
    id: string;          // "adjust:<id>". Skip it with POST /mirrors/adjust:<id>/skip
    ratio: number;       // leader's size after / before (1.5 = they added 50%)
    skipUntil: string;   // ISO
  } | null;
  txHash?: string | null;
  takeProfitPrice?: number | null;   // perpl: the owner's live TP (a real Perpl trigger order), $
  stopLossPrice?: number | null;     // perpl: the owner's live SL, $
  suggestions?: {                    // perpl: clan-mates' latest TP/SL suggestions (one per suggester)
    id: string; markerId: string; tradeId: string; fromMemberId: string; fromName: string;
    takeProfitPrice: number | null; stopLossPrice: number | null; createdAt: string;
  }[];
};

// A mirror following its leader's add or partial sell (SSE `adjustment`).
type Adjustment = {
  id: string; mirrorId: string; tradeId: string; clanId: string; userId: string;
  kind: 'add' | 'reduce';
  ratio: number;         // leader's size after / before the change
  status: 'pending' | 'skipped' | 'submitting' | 'done' | 'failed' | 'cancelled';
  skipUntil: number;     // ms. For a reduce it's "now": reductions don't wait
  sizeDelta: string | null;   // raw, what the member actually bought or sold
  notionalUsd: number | null; // $ spent (add) or received (reduce)
  tx: string | null; oid: number | null; rq: number | null;
  error: string | null;  // e.g. "capped: max_usd_per_trade", "retrying (1/2): …", "member left the clan"
  createdAt: number; updatedAt: number;
};

type ChatRoom = {                    // ids: "global" | "country:NG" | "cult:<id>"
  id: string; kind: 'global' | 'country' | 'cult'; name: string;
  icon: string;                       // "G" (Global) | the country's flag emoji | the cult's first letter; don't derive it from id
  memberCount: number;
  lastMessage: ChatMessage | null;    // the 'your groups' list line + time
};

type ChatMessage = {
  id: string;
  room: string;              // "global" | "country:NG" | "cult:<id>"
  kind: 'text' | 'system';   // system = a notice ("joined the cult", "opened BTC-PERP long 5x"): render as a pill; markerId links the trade
  clanId: string | null;     // set for cult rooms
  memberId: string; memberName: string;     // memberName = their username (short wallet until they pick one)
  memberAvatarUrl: string | null;           // path on the API, prefix with the API base URL
  body: string;              // plain text, up to 1000 chars. Render as text, never as HTML
  text: string;              // what to display: body, or for a system notice "<name> <body>" ("iwetan joined the cult")
  replyTo: string | null;    // a message id in the same room
  markerId: string | null;   // optional ChartMarker.id the message is about
  createdAt: string;         // ISO
};

type MemberStats = {         // ChartSnapshot.members[].stats, Profile.record
  verified: boolean; tradeCount: number; winRate: number | null;
  realizedPnlPerplUsd: number; realizedPnlMon: number; realizedPnlUsd: number | null; monPriceUsed: number | null;
  lastTradeAt: number | null;
  streak: number;            // own wins in a row, back from the latest close
  avgWinPct: number | null;  // mean return % of own winning trades
  recent: { d7: RecentWindow; d30: RecentWindow };     // own trades closed in the last 7 / 30 days
  copied: { tradeCount: number; winRate: number | null; realizedPnlUsd: number | null };
};

type RecentWindow = { tradeCount: number; winRate: number | null; realizedPnlUsd: number | null };

type ClosedTrade = { venue: 'perpl' | 'nadfun'; market: string; symbol: string; side: string;  // symbol: "BTC-PERP" | "$MOE"
                     returnPct: number | null;  // perpl: price move in the trade's direction; nad.fun: proceeds / cost - 1
                     pnlUsd: number | null; entryPrice: number | null; exitPrice: number | null;   // prices: perpl only
                     isWin: boolean; openedAt: number | null; closedAt: number; openTx: string;
                     tradeId: string | null;     // GET /v1/trades/:tradeId when Cult saw it open
                     copied: boolean };          // Cult opened it for them (never counts in the record)

type TradeView = {           // GET /v1/trades/:id: the "View trade" sheet, open or closed
  tradeId: string; markerId: string;
  member: { id: string; name: string; address: string };
  venue: 'perpl' | 'nadfun'; market: string; symbol: string; side: string; leverage: number;
  openedAt: number; openTx: string | null;
  status: 'open' | 'closed'; closedAt: number | null;
  result: { returnPct: number | null; pnlUsd: number | null; entryPrice: number | null; exitPrice: number | null; isWin: boolean } | null;
                             // verified by the indexer once closed; null while open or not indexed yet
  tradersIn: number; youCopied: boolean;
  cultId: string | null;     // a cult to open for context
};

type Profile = {             // GET /v1/members/:id  (id = "me" | user id | wallet)
  id: string; name: string; address: string; country: { code: string; name: string } | null;
  memberSince: number; isMe: boolean;
  record: MemberStats;
  openTrades: { tradeId: string; markerId: string; venue: string; market: string; symbol: string; side: string; leverage: number; openedAt: number }[];
  closedTrades: ClosedTrade[];                // newest first, up to 50
  cults: { id: string; name: string; visibility: string }[];   // public ones + any shared with you
};

type Home = {                // GET /v1/home
  topTrades: { rank: number; memberId: string; name: string; venue: string; market: string; symbol: string; side: string;
               returnPct: number; pnlUsd: number | null; closedAt: number;
               tradersIn: number;            // the caller + everyone who copied or stacked it ("3 traders were in")
               markerId: string | null;
               tradeId: string | null;       // "View trade" -> GET /v1/trades/:tradeId (null: a trade Cult never saw open; show the card data + profile)
               cultId: string | null;        // a cult to open for context: one you share with the trader, else a public one of theirs
               openTx: string }[];           // the week's best own trades across Cult
  sevenDay: { trades: number; profitUsd: number; positionsOpened: number };   // yours
  asOf: string;
};

// Names and photos everywhere: every `name` / `memberName` / `traderName` is the
// member's username (or their short wallet until they pick one), and every
// `avatarUrl` is a path like "/v1/avatars/<id>?v=<ts>" on the API: prefix it
// with NEXT_PUBLIC_CULT_API_BASE_URL. null = no photo: show initials.

type MarketListing = {       // GET /v1/markets, GET /v1/markets/:id
  venue: 'perpl' | 'nadfun'; id: string;    // perpl market id | token address
  symbol: string;            // "BTC-PERP" | "$MOE"
  name: string; priceUsd: number | null;
  change24hPct: number | null; volume24hUsd: number | null;   // perps only for now
  imageUri: string | null;   // memes
  maxLeverage: number;       // memes: 1
};

type DepositInfo = {         // GET /v1/wallet/deposit
  address: string;           // show it big with a copy button + QR; no contract addresses anywhere
  network: { name: string; chainId: number };
  tokens: { symbol: 'MON' | 'USDC' | 'AUSD'; name: string; what: string; balance: number; balanceUsd: number | null }[];
                             // testnet: MON + AUSD; mainnet adds USDC
  tradingAccountUsd: number | null;   // dollars in the Perpl account
  totalUsd: number | null;
};

type Leaderboard = {
  scope: string;             // "global" | "country:NG" | "cult:<id>"
  name: string;              // "Global" | "Nigeria" | cult name
  metric: 'realizedPnlUsd'; period: 'all' | '30d' | '7d';   // ?period= on every board route
  entries: { rank: number; memberId: string; name: string; address: string; country: string | null;
             realizedPnlUsd: number; winRate: number | null; tradeCount: number; copiedTradeCount: number }[];
  me: (same fields, but rank: number | null) | null;   // your row even when unranked (rank null)
  rankedCount: number; memberCount: number; asOf: string;
};

type CultStanding = { rank: number; cultId: string; name: string; memberCount: number;
                      realizedPnlUsd: number; winRate: number | null; tradeCount: number; joined: boolean };

type ChartSnapshot = {
  clan: Clan; markets: Market[]; selectedMarket: Market;
  candles: { time: number /* unix s */; open: number; high: number; low: number; close: number }[];
  markers: ChartMarker[];
  members: {
    id: string; name: string; address: string;
    // OWN trades only (product decision 2026-09-27): round trips Cult opened for them
    // (auto-mirrors, stacks) don't count here; they're in stats.copied.
    winRate: number | null;        // 0..1 across both venues; null = no closed own trades or not verified
    realizedPnlUsd: number | null; // $: Perpl + Nad.fun (MON at stats.monPriceUsed)
    tradeCount: number; verified: boolean;   // verified = the indexer has this wallet's on-chain history
    stats: { verified: boolean; tradeCount: number; winRate: number | null; realizedPnlPerplUsd: number;
             realizedPnlMon: number; realizedPnlUsd: number | null; monPriceUsed: number | null; lastTradeAt: number | null;
             copied: { tradeCount: number; winRate: number | null; realizedPnlUsd: number | null } };  // show apart, e.g. +3 copied
  }[];
  asOf: string; autoMirrorOptOutWindowSeconds: number;
};

type WalletAction = { to: string; data: string; value?: string; chainId: number; label: string };

type Holding = {         // GET /v1/positions
  venue: Venue; market: string; symbol: string; side: TradeSide;
  sizeRaw: string; size: number;
  entryPriceAusd: number | null; markPriceAusd: number; valueAusd: number; pnlAusd: number | null; leverage: number;
};

type Fill = {            // POST /v1/positions/open|close
  venue: Venue; market: string; side: TradeSide; sizeRaw: string; size: number;
  priceAusd: number; notionalAusd: number; orderId?: number; requestId?: number; txHash?: string | null;
};

type NadMarket = Market & { name: string; graduated: boolean; priceAusd: number };  // GET /v1/nadfun/markets
```

**Member track record** comes from the indexer's GraphQL, set by `INDEXER_GRAPHQL_URL`
(and optionally `INDEXER_GRAPHQL_SECRET` for Hasura), cached for 15s. The backend sends
exactly:
`query CultMemberStats($ids: [String!]!) { Trader(where: { id: { _in: $ids } }) { id trades { openTx realizedPnlUsd isWin closedAt } nadFunTrades { openTx realizedPnlMon isWin closedAt } } }`
with lowercase wallet ids. Or the same rows over SQL with `INDEXER_PG_URL`.

**Own trades only (2026-09-27).** The backend splits each member's round trips by
their opening tx. If Cult sent it (in `engine_txs`, or a mirror's or stack's
`open_tx`), the round trip is copied; otherwise it's their own. Only own round trips
make the record. This was checked live on the indexed partial-sell run: the leader
has 1 own trade, and both followers have 0 own and 1 copied. (An earlier version
queried the `Trader` aggregates, which count everything.) **Confirmed by the indexer (2026-09-27):** `indexer/API.md`
now uses this Hasura `where` form, and the same fields were checked against the live
indexer's `Trader` table in Postgres for the four reference Nad.fun wallets. Still
open: a **hosted GraphQL URL**. Hasura needs Docker (not available in either agent's
environment), so the URL has to come from Envio Cloud or `envio dev` on a machine with
Docker (`http://localhost:8080/v1/graphql`). Until `INDEXER_GRAPHQL_URL` or
`INDEXER_PG_URL` is set, members show `verified: false`.

**Without Hasura or Docker (2026-09-27):** the indexer also runs as `envio start`
with `ENVIO_HASURA=false`, writing straight to Postgres. The backend then reads the
same `Trader` fields over SQL, via `INDEXER_PG_URL` (a read-only user). This was
checked live: the indexer ran over the backend's partial-sell run and the backend
served those wallets `verified: true` with the indexed PnL. Hosting it takes a
Postgres, plus an Envio API token for HyperSync (a full-history RPC sync is too
slow).
If the indexer is unset or down, members come back `verified: false` with nulls;
the chart still loads. The indexer keeps MON and AUSD apart. The backend's combined
`realizedPnlUsd` converts MON at the current price, which it reports as
`monPriceUsed`, so nothing is mixed silently.

**Perpl marker PnL** is `(mark - entry) x size` against Perpl's live mark, excluding the
closing fee and unsettled funding. **Nad.fun marker value** is what selling that
amount on the router would return right now, converted at Perpl's MON mark. It
therefore already includes curve fees and price impact, so a fresh buy shows about
−4% immediately. `winRate` and `realizedPnlUsd` are
always `null` from the backend. Verified track record comes from the indexer.

### Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/v1/health` | none | `{ ok: true }` |
| GET | `/v1/status` | none | Public. `{ storage: { host: 'railway'\|'other', persistent: boolean \| null }, indexer: { source: 'none'\|'graphql'\|'postgres', connected: boolean \| null, chains: { chainId, indexedBlock, headBlock, behind, caughtUp, events }[], wallets: number \| null } }`: is the verified-records indexer reachable and caught up (`wallets` = wallets with on-chain history). `storage.persistent: false` means the backend's database is wiped on every deploy (no volume) |
| GET | `/v1/config` | none | `{ chainId, venues: ['perpl','nadfun'], displayUnit: 'USD', monPriceAusd /* $ per MON */, autoMirrorOptOutWindowSeconds, mirrorPolicyBounds, markets: Market[] /* perpl */ }` |
| GET | `/v1/nadfun/markets?order=latest_trade\|market_cap\|creation_time` | none | `{ markets: NadMarket[] }` (MON-quoted tokens only) |
| GET | `/v1/me` | none | `{ id, address, name, username, needsUsername, pinSet, avatarUrl, country: { code, name } | null, rooms: ChatRoom[], clans: Clan[], perpl: { accountId, keyEnrolled, forwarding }, balances: { perplMarginUsd /* null until a Perpl account exists */, walletUsd /* AUSD in the wallet, what memes spend */, predictionsUsd /* pUSD in their Polymarket account; null until opened. Part of the one balance */, mon, monUsd, gasReserveMon, lowGas, memesPayWith: 'ausd' \| 'mon' } \| null, signer: { prepared, attached, policyCurrent }, usdcConverted: { usdc, ausd, tx, at } \| null }`. `usdcConverted` is the member's last automatic USDC→AUSD conversion if it was in the last 10 minutes (show "your 20 USDC is now $19.98"). `signer` is checked with Privy: `attached=false` means the member hasn't added the backend signer yet; `policyCurrent=false` means their caps changed and they must re-approve (call `/v1/privy/signer` + `addSigners` again). Until then, Nad.fun mirrors for them are cancelled with that reason`. `lowGas` means the member has less MON than the gas reserve and can't sign or be mirrored on Nad.fun; show a top-up |
| GET | `/v1/privy/signer` | none | `{ signerId, policyIds: string[], capAusd, maxBuyMon, monPriceAusd }`. For **every** member (not only Auto-follow): their own trades, perp top-ups and USDC conversions are signed under it. `capAusd` = `TRADING_CAP_USD` ($1,000 default) or a higher Auto-follow limit. A new policy is issued whenever the cap **or the rule set changes**, and the frontend must `addSigners()` again. `/v1/me.signer` tells you when that's needed |
| GET | `/v1/perpl/setup?depositRaw=` | none | `SetupStatus` (below) |
| POST | `/v1/enrollment/perpl/challenge` | none | `{ challengeId, typedData, expiresAt }` |
| POST | `/v1/enrollment/perpl` | `{ challengeId, signature }` | `204` |
| GET | `/v1/usernames/:name` | none (public, no sign-in needed) | `{ available: boolean, reason? }`. 3-20 letters, digits or `_`, starting with a letter; unique ignoring case; a few names reserved |
| POST | `/v1/me/username` | `{ username }` | `{ username, name }`. `/v1/me.needsUsername` is true until they pick one: ask **first, at sign-in**. `409` taken, `400` invalid |
| POST | `/v1/me/pin` | `{ pin, currentPin? }` | `{ pinSet: true }`. A 4-digit PIN; `/v1/me.pinSet` is false until one is set: ask **right after the username** (existing members on their next visit). Changing it needs `currentPin`. Errors carry `code`: `pin_invalid`/`pin_weak` (400; 0000, 1234, 9876…), `pin_missing` (400), `pin_wrong` (403, says tries left), `pin_locked` (423, 5 wrong tries = 15 min). Stored as a keyed scrypt hash |
| POST | `/v1/me/pin/reset` | `{ pin }` | `{ pinSet: true }`. Forgotten PIN: allowed only within 10 minutes of a Privy sign-in (any login method's `latest_verified_at`), else `403` "Sign in again" |
| POST | `/v1/me/avatar` | `{ image: "data:image/png;base64,…" }` | `{ avatarUrl }`. PNG, JPEG or WebP up to 512 KB. Resize in the browser first (256×256 is plenty) |
| DELETE | `/v1/me/avatar` | none | `204` |
| GET | `/v1/avatars/:userId` | none (public) | The image, cached for good (the URL's `?v=` changes with each upload) |
| GET | `/v1/markets?q=&venue=&limit=` | none (public) | `{ markets: MarketListing[] }`. Perps and memes in one list. `q` searches symbol, name, or a token address |
| GET | `/v1/markets/:id?resolution=` | none (public) | `{ market: MarketListing, candles, resolution }`. The market page: chart + price. Trade with `POST /v1/positions/open` |
| GET | `/v1/wallet/deposit` | none | `DepositInfo` |
| POST | `/v1/me/country` | `{ country: "NG" }` | `{ country: { code, name }, rooms: ChatRoom[] }`. ISO 3166 alpha-2. Adds you to that country's chat and leaderboard. Change it any time. `400` if it isn't a country |
| POST | `/v1/cults` | `{ name, visibility?: 'private' \| 'public', policy? }` | `201 Clan`. Just a name is enough: private, Auto-follow off |
| POST | `/v1/cults/join` | `{ inviteCode }` or `{ cultId }` | `Clan`. **One tap, no signature**, Auto-follow off. `cultId` only for public cults. `409` if you're already in. (`{ challengeId, signature }` still completes a join with Auto-follow on) |
| POST | `/v1/cults/:id/auto-follow` | `{ enabled: false }` | `Clan`. Turns copying off at once; anything pending for you there is cancelled; open copies still follow their leader's partial sells and exit. `{ enabled: true }` is a `400`: turn it on with `/policy/challenge` (`enabled: true`, limits from `/v1/config.autoFollowDefaults`) then `/policy`; that message starts "Turn on Auto-follow in the Cult" |
| POST | `/v1/chat/:room/pin` | `{ messageId }` or `{ messageId: null }` | `{ pinned }`. The cult owner only (`403`) |
| GET | `/v1/home` | none | `Home` |
| GET | `/v1/trades/:id` | none | `TradeView`. Any member can view (trades are on-chain); copies are counted, never named. Open trades: show the live marker (open the cult chart at `markerId`). Closed ones: show `result`. `404` if unknown |
| GET | `/v1/members/:id` | none | `Profile`. `id` = `me`, a user id, or a wallet. `404` if unknown |
| GET | `/v1/cults/discover?limit=` | none | `{ cults: [{ id, name, visibility: 'public', memberCount, createdAt, joined }] }`. Public cults only |
| POST | `/v1/cults/:id/visibility` | `{ visibility }` | `Clan`. Owner only (`403` otherwise) |
| POST | `/v1/cults/join/challenge` | `{ inviteCode, policy }` **or** `{ cultId, policy }` | `{ challengeId, message }`. `inviteCode` is `ABC-DEF`, and `abcdef` or `abc def` work too. `cultId` only works for public cults (`404` for private). `409` if you're already in it. The message starts `Join the Cult "…" (ABC-DEF)` |
| GET | `/v1/chat/rooms` | none | `{ rooms: ChatRoom[] }`: global, your country, your cults |
| GET | `/v1/chat/:room/messages?before=&limit=` | none | `{ messages: ChatMessage[], hasMore, pinned: { id, memberName, body } \| null }`. Global is open to everyone signed in; a country room only to members who picked that country (`403`); a cult room only to its members (`404`) |
| POST | `/v1/chat/:room/messages` | `{ body, replyTo?, markerId? }` | `201 ChatMessage`. The same limits as the cult chat |
| GET | `/v1/chat/:room/events` | none | SSE: `message` (a `ChatMessage`) and `ping`. For the global and country rooms; cult rooms also come on the cult stream |
| GET | `/v1/leaderboards/global?limit=&period=` | none | `Leaderboard`. `period` = `all` (the default), `30d` or `7d`. The same parameter works on the country and cult boards |
| GET | `/v1/leaderboards/country/:code?` | none | `Leaderboard`. With no code, it uses your country (`409` if you haven't picked one) |
| GET | `/v1/cults/:id/leaderboard` | none | `Leaderboard` for that cult. Members only, or anyone for a public cult |
| GET | `/v1/leaderboards/cults?limit=` | none | `{ entries: CultStanding[], asOf }`. Public cults ranked by their members' summed own PnL |
| POST | `/v1/cults/join` | `{ challengeId, signature }` | `Clan` |
| POST | `/v1/clans/:clanId/policy/challenge` | `{ policy: MirrorPolicy }` | `{ challengeId, message }`. The message starts "Update my mirror policy in Cult clan …" and spells out the new caps |
| POST | `/v1/clans/:clanId/policy` | `{ challengeId, signature }` | `Clan`. The same signed-consent rule as joining; the signed text is stored. If `maxUsdPerTrade` went up, call `GET /v1/privy/signer` again and `addSigners()` with the new `policyIds`, otherwise Privy keeps the old cap |
| POST | `/v1/clans/:clanId/leave` | none | `204`. Your pending mirrors and pending adds are cancelled. Mirrors already open still follow partial sells and unwind when their leader exits, so nothing is orphaned |
| GET | `/v1/clans/:clanId/chart?marketId=&resolution=` | none | `ChartSnapshot`. `marketId` is a Perpl id or a Nad.fun token. `resolution` is in seconds (60, 300, 900, 1800, 3600, 14400, 86400). `markets` = all Perpl markets plus the Nad.fun tokens the clan currently holds |
| GET | `/v1/clans/:clanId/events` | none | SSE stream (below) |
| POST | `/v1/clans/:clanId/mirrors/:mirrorId/skip` | none | `204`. `:mirrorId` may be the bare id, the chart marker id (`mirror:<id>`), or a pending add (`adjust:<id>`, from `marker.pendingAdd.id`). `409` if not pending or the window has passed; partial sells can't be skipped |
| GET | `/v1/clans/:clanId/messages?before=<messageId>&limit=50` | none | `{ messages: ChatMessage[], hasMore }`. Newest page by default, oldest→newest within the page; pass the first message's id as `before` to load older. Members only (`404` otherwise) |
| POST | `/v1/clans/:clanId/messages` | `{ body, replyTo?, markerId? }` | `201 ChatMessage`. Also pushed to the clan's SSE as `message`. `400` empty or over 1000 chars; `429` over 8 messages per 10s |
| POST | `/v1/clans/:clanId/stack` | `{ markerId, notionalUsd, leverage? }` | `StackResult`. Same for both venues; `leverage` is ignored on Nad.fun |
| GET | `/v1/positions` | none | `{ positions: Holding[] }` (both venues) |
| POST | `/v1/shares` | `{ markerId, includeClan }` | `201 { id, url }`. Only your own marker (`403` otherwise). A frozen snapshot at share time |
| GET | `/v1/shares/:id` | none (public) | `PublicShare = { id, traderName, traderAvatarUrl /* path or null */, marketSymbol, venue, side, leverage /* x; null for memes and older cards */, pnlUsd, roiPercent, notionalUsd, entryPrice, markPrice, closedAt, sharedAt, traderRecord: { verified, tradeCount, winRate, realizedPnlUsd, streak }, includeClan, clanName? }`. `traderRecord` is the sharer's verified record (own trades), frozen at share time; show it as the proof behind the card, or show "unverified". **Never** carries clan id, invite code or members; `clanName` only if `includeClan`. Money in $. `pnlUsd`/`roiPercent`/`notionalUsd` can be `null` when no live holding backs the marker; render that honestly |
| POST | `/v1/funding/usdc/prepare` | `{ amountUsdc: "25.5", depositToPerpl?: true }` | `FundingPlan = { id, expiresAt, requiredUsdc, minAusdOut, expectedAusdOut, depositToPerpl, actions: WalletAction[] }`. The member sends the actions in order: approve USDC → Kuru Flow `executeSwap` → (if `depositToPerpl`) approve AUSD and `createAccount`/`depositCollateral` of the guaranteed amount. With `depositToPerpl: false` the AUSD stays in the wallet, which is what meme buys spend. The plan expires in 5 minutes, because routes go stale. `409` with a plain `message` on testnet or when no route exists |
| POST | `/v1/funding/usdc/confirm` | `{ planId, hashes: string[] }` | `{ planId, done, steps: [{ label, txHash, ok }], perplAccountId }`. Each hash is checked on-chain against the planned action |
| POST | `/v1/positions/open` | `{ marketId, side, marginUsd, leverage?, cultIds? }` | `Fill`. `cultIds` is "Post to": which of your cults get the chat notice, show it on their chart and copy it with Auto-follow. Omitted = all your cults; `[]` = just you; a cult you're not in = 400. Perpl: side `long`/`short`, notional = margin x leverage. If the Perpl account is short of margin, the backend tops it up first: wallet AUSD, then MON swapped to AUSD on Kuru (never the 0.25 MON reserve). `409 { message }` when the member doesn't have enough, `503` when no swap route answers. Nad.fun: side `buy`, spends `marginUsd` worth of MON, signed by the backend signer |
| POST | `/v1/positions/tpsl` | `{ marketId, takeProfit?, stopLoss? }` ($ prices; `null` removes a leg, omitted keeps it) | `{ takeProfit, stopLoss }`. Perpl only. Placed as Perpl trigger orders (reduce-only, fire on mark price, linked to the position so Perpl cancels them when it closes). `400` if a price is on the wrong side of mark. A TP/SL firing closes the leader's position, so their mirrors close too |
| POST | `/v1/clans/:clanId/markers/:markerId/suggest-tpsl` | `{ takeProfit?, stopLoss? }` | `201 Suggestion`. **Drag-to-suggest** on a clan-mate's Perpl marker. It's stored and pushed as SSE `suggestion`; only the owner can apply it, by sending the same numbers to `/v1/positions/tpsl` |
| POST | `/v1/positions/close` | `{ marketId, sizeRaw? }` | `Fill`. Nad.fun sells the whole balance unless `sizeRaw` (token wei) is given |

Notes:

- **Perpl setup is a loop.** `GET /v1/perpl/setup` returns
  `{ step, wallet, perplAccountId, collateralBalance, minAccountOpen, actions: WalletAction[] }`,
  where `step` is one of `needs_collateral`, `needs_account`, `needs_key`,
  `needs_forwarding` or `ready`. Send `actions` in order from the member's Privy
  wallet (waiting for each receipt), then call it again. When the wallet has too
  little AUSD to open the account, `needs_account` starts with a Kuru swap from
  USDC (mainnet) or MON, labelled "swap … to dollars (AUSD)", then approve and
  `createAccount`. `needs_collateral` now means AUSD, USDC and MON together
  can't cover it. On `needs_key`, run the enrollment challenge: sign
  `typedData` with `eth_signTypedData_v4`, exactly as returned, then POST the
  signature. The backend completes the Perpl enrollment.
- **Backend signer (required).** Before the member's first trade (any venue),
  call `GET /v1/privy/signer`. It returns
  `{ signerId, policyIds, capAusd, maxBuyMon, monPriceAusd }`. Then call Privy's
  `useSigners().addSigners({ address, signers: [{ signerId, policyIds }] })`.
  - **Privy's policy lets the backend:** approve and deposit AUSD into Perpl up to
    `capAusd` per tx; make Nad.fun `buyWithNative` calls up to `maxBuyMon` per buy,
    with tokens delivered to the member; make Nad.fun `sellToNative` calls with
    proceeds to the member; and approve tokens to the Nad.fun router. It can also make
    Kuru Flow `executeSwap` AUSD→MON up to `capAusd`, MON→AUSD, and (mainnet)
    USDC→AUSD up to `capAusd`, all with zero fees and output to the member, and
    approve AUSD or USDC to Kuru up to `capAusd`.
  - **What the backend does with it on its own:** converts USDC that arrives in a
    member's wallet to AUSD (checked every 20s, from $1), and tops up the Perpl
    account before a perp trade (above).
  - **Privy refuses everything else:** withdrawals, transfers out, a buy, sell or
    swap routed to anyone else (including Kuru's `executeSwapWithReceiver`), swaps
    carrying any fee, `createAccount`, `allowOrderForwarding`, and signing
    Perpl key enrollments.
  - Those last three are the member's own one-time setup, signed in the browser via
    `/v1/perpl/setup` actions and the enrollment challenge.
  - `maxBuyMon` is the member's `maxUsdPerTrade` converted at Perpl's MON mark price
    when the grant was made.
- **Joining a clan** is standing consent. The challenge `message` spells out the
  policy in plain words. The member signs it with `personal_sign`, and the backend
  checks the signer is their wallet and stores the signed text. It is never re-asked
  per trade.
- **`positions/open` is the member's own trade.** It becomes a `leader` marker and
  clan-mates get auto-mirrored.
- **`stack` is the manual path.** `markerId` is any `ChartMarker.id` (or a bare trade
  id). It opens `notionalUsd` of the same side on the caller's own account and is
  never auto-mirrored. It doesn't auto-close when the target closes. `StackResult`
  is `{ id, venue, status: 'open' | 'failed', market, side, size, notionalAusd, leverage, orderId?, txHash?, error? }`.
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
| `trade_changed` | the leader added or partly sold: same shape, with the new `size` (and average `entryPrice` after an add) |
| `trade_closed` | same shape, `closedAt` set |
| `mirror` | a mirror changed: `{ id, tradeId, clanId, userId, status, skipUntil, marginUsd, notionalUsd, size, capApplied, openOid, openTx, closeOid, closeTx, error, … }` |
| `adjustment` | a mirror following an add or partial sell: `Adjustment`. A `pending` add is skippable until `skipUntil` |
| `suggestion` | a clan-mate suggested a TP/SL: the same shape as `ChartMarker.suggestions[]` |
| `message` | a new message in this cult's room: `ChatMessage` |
| `ping` | every 15s |

Mirror `status` goes `pending → skipped | submitting → open → closed`. If a mirror
fails **before any order left** (an RPC or route hiccup), it goes back to `pending`
with a new `skipUntil` and `error: "retrying (n/2): …"`, and is tried up to twice
more. A failure after an order left is never retried, so a position can't be doubled.
If the backend spots a leader's Nad.fun trade more than 120s after it happened (for
example, catching up after a restart), that trade is tracked so its exit still
unwinds anything open, but followers get `cancelled` with `error: "leader trade
detected Ns late … not mirrored at a stale price"`. Copying it late would be a
different trade. It can also
end in `failed` or `cancelled`, where `cancelled` means the leader closed before the
mirror fired. On any event, re-fetch `/chart` or patch the marker locally. Browser
`EventSource` can't send headers, so fetch the stream with the `Authorization` header
(for example `@microsoft/fetch-event-source`).

### Predictions (Polymarket) — `/v1/predictions/*`

Live odds and charts come straight from Polymarket's public APIs in the browser
(`frontend/src/lib/polymarket.ts`). The backend places members' bets.

**The account.** Each member gets a Polymarket **Deposit Wallet** on Polygon, owned by
their Privy wallet. Dollars there are **pUSD**. Opening it takes up to four
signatures from the member's own wallet, once: sign in to Polymarket, open the
wallet (gasless), turn on trading (approvals), and *"Let Cult place your bets"*
(a **session key**: trade only, it can never withdraw, 180 days). With a session key,
bets are signed by the backend and need no prompt. Without one (until Polymarket
enables session keys on our builder key), each bet asks for one signature.

**Signature steps (FlowStep).** Calls that may need the member's signature answer with:

```ts
type SignatureRequest = { challengeId: string; label: string; kind: 'typedData' | 'message'; typedData: EIP712 | null; message: `0x${string}` | null; expiresAt: string };
type FlowStep<T> =
  | { status: 'needs_signature'; flowId: string; signature: SignatureRequest }   // HTTP 202
  | { status: 'working'; flowId: string; label: string }                        // HTTP 202
  | { status: 'done'; flowId: string; result: T };                              // HTTP 200
```

- `needs_signature`: sign `typedData` with `eth_signTypedData_v4` (it already carries
  `EIP712Domain`), or `message` with `personal_sign`, using the **embedded** wallet. Then
  `POST /v1/predictions/sign { flowId, challengeId, signature }`, which answers with the
  next FlowStep. Show `label` (e.g. "Sign in to Polymarket", "Confirm your bet").
- `working`: `GET /v1/predictions/flows/:flowId` (waits up to 20s), repeat.
- `done`: `result` is the call's result.
- A signature from another wallet: `403`. An expired or replaced step: `404/410`, so start again.
  `DELETE /v1/predictions/flows` cancels the member's open flow.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/predictions/account` | | `{ enabled, step: 'unavailable'\|'needs_setup'\|'needs_funds'\|'ready', reason, wallet, balanceUsd, signsEachBet, funding: { from:'AUSD', minUsd, network } \| null, access: { country, predictions: 'open'\|'close_only'\|'blocked', perps } }` |
| POST | `/predictions/setup` | | FlowStep → `account` (same shape as above, without `access`) |
| POST | `/predictions/fund` | `{ amountUsd }` (≥ 2) | `{ actions: WalletAction[], depositAddress, amountUsd, sendUsd, feeUsd, receiveUsd, seconds }`: AUSD from the Cult wallet on Monad to the member's own Polymarket bridge address, landing as pUSD in ~30s. The bridge fee goes on top: `amountUsd` is what lands, `sendUsd` (= `amountUsd` + `feeUsd`) is what leaves the wallet. The member signs `actions` like the setup actions |
| POST | `/predictions/withdraw` | `{ amountUsd }` (≥ 2) | FlowStep → `{ amountUsd, tx, seconds }`: pUSD back to the Cult wallet as AUSD |
| GET | `/predictions/positions` | | `{ positions: PredictionPosition[], closed: PredictionClosed[], redeemable: string[] }` (`redeemable` = position ids whose market resolved: collect them) |
| POST | `/predictions/orders` | `PredictionOrder` | `PredictionPosition` (200), or 202 + FlowStep → `PredictionPosition` |
| POST | `/predictions/sell` | `{ positionId, price }` | `PredictionSale` (200), or 202 + FlowStep → `PredictionSale` |
| POST | `/predictions/redeem` | `{ positionId }` | FlowStep → `{ positionId, payoutUsd, tx }` |
| POST | `/predictions/bets` | `{ eventSlug }` | `{ bets: PredictionBet[] }`: cult-mates' open bets on that event, only in cults the bet was posted to |

`PredictionOrder`, `PredictionPosition`, `PredictionSale`, `PredictionClosed` and
`PredictionBet` are exactly the shapes in `frontend/src/lib/contracts.ts`.
`marketId` is the Polymarket (Gamma) market id (`PredictionOutcome.id`); `price` is the
price the member saw for their side. Bets are market orders (fill-and-kill) never more
than `PREDICTIONS_SLIPPAGE` (default 5%) past that price. `cultIds` works like
"Post to" on trades. Each bet and sale posts a notice to those cults
("bet YES on "…" at 52¢").

Errors are `{ message, code? }`:
- `409 code: 'needs_setup'`: run setup first.
- `409 code: 'needs_funds'`: move dollars in (`/fund`).
- `403`: Polymarket doesn't take new bets from the member's location. This is checked
  from the request IP, falling back to the member's chosen country. Close-only
  countries (US, UK, France, …) can still sell.

**Location.** Polymarket requires builders to block restricted places. Our
server's IP must also be allowed: **run the backend in an EU region**
(Railway: Amsterdam).

### Cross-chain (Aurora Intents) — `/v1/intents/*`

Money in from, and out to, 30+ chains on NEAR Intents' 1Click engine through Aurora
Intents. **Monad mainnet only.** `GET /v1/config` → `features.crossChain`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/intents/chains` | | `{ enabled, chains: [{ chain, name, evm, tokens: [{ assetId, symbol, decimals, priceUsd }] }] }` (Monad left out) |
| POST | `/intents/deposit` | `{ originAsset, amount, refundTo? }` (`amount` in the coin's units, e.g. `"0.5"`) | `SwapView`: a one-time `depositAddress` (+ `depositMemo` on memo chains) on the origin chain. Whatever is sent there arrives as **USDC in the member's Cult wallet**, which becomes dollars by itself. Refunds go to `refundTo`, or else to the member's own address (EVM) or their Intents account (others) |
| POST | `/intents/withdraw` | `{ destinationAsset, amountUsd, recipient, pin }` (≥ $5; the member's PIN, see `/v1/me/pin`) | `SwapView & { actions: WalletAction[] }`: swap dollars→USDC (if needed), then send to the quote's address. The member signs `actions` |
| GET | `/intents/status/:depositAddress` | | `{ status, done, received, receivedUsd, refunded, refundReason, txs: [{ hash, url }] }` (`status`: `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED`) |
| POST | `/intents/submit` | `{ depositAddress, txHash }` | 204, so it's picked up sooner |
| GET | `/intents/swaps` | | `{ swaps: [...] }` (the member's recent ones) |

`SwapView = { depositAddress, depositMemo, kind: 'deposit'|'withdraw', chain, chainName, symbol, amountIn, amountInUsd, receive, receiveSymbol, receiveUsd, minReceive, seconds, deadline, status }`.

### Withdraw on Monad — `POST /v1/wallet/withdraw`

`{ symbol: 'MON'|'AUSD'|'USDC', amount, to, pin }` → `{ symbol, amount, to, actions: WalletAction[] }`.
The backend can't move funds, so the member's wallet sends `actions` and the frontend
shows the tx hash. MON keeps the gas reserve. Sending to your own Cult address is refused.
`pin` is the member's 4-digit PIN (money leaving Cult); PIN errors as in `/v1/me/pin`.

### `GET /v1/config` → `features`

`{ predictions: boolean, crossChain: boolean }`. Each is on when its keys are set
(`POLYMARKET_BUILDER_*`, `AURORA_INTENTS_API_KEY` + mainnet).

## Indexer API (correlating chain events with clans)

All routes need `X-Indexer-Key`.

| Method | Path | Returns |
|--------|------|---------|
| GET | `/v1/indexer/accounts` | `{ accounts: [{ userId, wallet, perplAccountId, clanIds: string[] }] }` |
| GET | `/v1/indexer/orders?since=<ms>` | `{ orders: [{ perplAccountId, requestId, kind: 'mirror_open' \| 'mirror_close' \| 'mirror_add' \| 'mirror_reduce' \| 'stack_open', refId, mirrorId, clanId, tradeId, createdAt }] }` |
| GET | `/v1/indexer/txs?since=<ms>` | `{ txs: [{ venue: 'nadfun', txHash, wallet, kind: 'mirror_open' \| 'mirror_close' \| 'mirror_add' \| 'mirror_reduce' \| 'stack_open', refId, mirrorId, clanId, tradeId, createdAt }] }` |
| GET | `/v1/indexer/trades?since=<ms>` | `{ trades: [{ tradeId, venue, userId, perplAccountId, market, side, positionId, openTx, openedAt, closedAt }] }` (`market` = Perpl id or token) |

`mirror_add` / `mirror_reduce` are a mirror following its leader's add or partial sell;
their `refId` is the adjustment id and `mirrorId` the mirror. Treat every `mirror_*`
kind as auto-mirror (match the prefix, not a fixed list).

**Nad.fun:** a router `Buy`/`Sell` whose tx hash is in `/txs` was sent by the engine
(an auto-mirror or a manual stack). Any other router trade by a clan member's wallet
is their own. `/accounts` now lists every member wallet, including those with no
Perpl account.

**How to correlate (Perpl).** Perpl's `OrderRequest(perpId, accountId, orderDescId, orderId, …)`
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
- **Rate limits:**
  - Per member: 240 requests/min, and 20/min on routes that send orders or txs
    (`positions/open|close|tpsl`, `stack`, `suggest-tpsl`, `funding/usdc/*`,
    `predictions/orders|sell|redeem|fund|withdraw|setup`, `intents/deposit|withdraw`,
    `wallet/withdraw`).
  - Per IP: 120/min on public routes.
  - Chat has its own 8 per 10s.
  - Over a limit returns `429 { message }` with a `Retry-After` header in seconds
    (exposed via CORS). Wait that long; don't retry in a loop.
