# Frontend contract status

Status (2026-09-27): I read `CONTRACTS.md` at backend commit `8c0c1c1325da3fff7f88b4123423e11b58ed175d` in full. The frontend now follows its Perpl types and routes for config, clans, chart, skip, stack, setup, and EIP-712 key enrollment. The backend's current chain is Monad testnet `10143`; the UI selects that chain for embedded wallets and validates every wallet action against runtime `/v1/config`. The opt-out deadline comes from each marker's `skipUntil`; the backend enforces it.

## Open integration gaps

- The newest product brief supersedes the older spec on funding: USDC must flow through Kuru, with no Agora integration or AUSD presented to users. The backend contract still discusses Agora and says Kuru is banned. Backend must resolve this conflict and publish a USDC funding route. The frontend will not send funds to an invented destination. Privy card funding is not available for the current testnet; the control is disabled there.
- The contract has no Nad.fun market, holdings, stack, or enrollment shape yet. The shared chart already supports a Nad.fun venue and distinct manual/auto markers, but token execution remains unavailable until the API is defined.
- `ChartMarker` does not include Perpl TP/SL prices. The chart can draw them when supplied, but cannot show real levels from the current response.
- Indexer verified win rate, realized PnL, and trade count are nullable/unverified pending its API. The frontend never substitutes demo results.
- Public result sharing has no published create/read endpoint. The provisional public card route omits clan identity unless `includeClan` is true, but the backend must enforce privacy in its payload. A public link cannot be created reliably until the contract is published.
- Backend `MirrorPolicy` is `{ enabled, balancePercentCap, maxUsdPerTrade }`, with `(0,100]` and `[1,1000000]` bounds. Both creator and join forms collect it. The contract does not yet define how a member updates policy after joining.

Provisional Nad.fun and public-share types are isolated in `src/lib/contracts.ts`; their calls must be reconciled when backend and indexer publish those contracts. No sample prices, PnL, or track records are presented as real data.
