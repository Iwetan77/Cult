# Frontend contract assumptions (temporary)

The shared `CONTRACTS.md` is not published in origin yet. These are the UI shapes needed for parallel work; all names and endpoints below are provisional and must be reconciled with backend and indexer contracts before integration is considered complete.

- A unified clan chart response needs venue (`perpl` or `nadfun`), market identity, candles, member holdings/positions, live mark/value, and a source (`leader`, `auto_mirror`, `manual_stack`) for each marker. Perpl positions additionally need side, TP and SL; Nad.fun holdings need token address, symbol, amount, and buy price.
- Clan join needs a wallet-signed challenge and a member mirror policy with a balance-percent cap and USD maximum per trade. Backend must define the opt-out window and exact cap units and bounds.
- Manual stack needs venue-aware quote/prepare and a wallet-signable transaction, separate from backend automatic mirroring.
- Funding needs USDC balance/chain requirements, a Privy on-ramp handoff, then backend-prepared wallet transactions for its Kuru and account setup flow. The UI will not expose internal settlement assets.
- Enrollment needs a venue-specific wallet-signable challenge for Perpl and Nad.fun, plus a submit endpoint.
- Indexer track record needs per-member verified win rate, realized PnL, and trade count across both venues, scoped to a clan.
- Public share links need an explicit `includeClan` choice. Omitting the clan must remove its ID, name, invite code, and member context from public payloads.

No sample prices, positions, PnL, or track records will be presented as real data.
- Pending automatic mirrors need `mirrorStatus: pending` and an absolute `skipUntil` deadline in the chart marker, plus an authenticated skip endpoint. The backend must enforce the deadline; the UI clock is only a guide.
- Provisional REST paths are in `src/lib/api.ts`. The backend must supply the final paths, response envelopes, and the exact wallet action encoding. No trading call should be treated as production-ready until those match `CONTRACTS.md`.
- The UI currently targets Monad mainnet (chain ID 143) so Privy card funding can be offered; the final chain ID and USDC contract must be confirmed by the backend contract.
