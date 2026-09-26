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
