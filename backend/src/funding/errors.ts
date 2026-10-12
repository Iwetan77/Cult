// The member doesn't hold enough for what they asked. The API answers 409 with
// the message, which says what's needed.
export class FundsError extends Error {}

export class FundingAuthorizationError extends FundsError {
  constructor(cause: Error) {
    super('Trading permission refused the funding transaction. Renew trading permission in the app, then check your trading balance before trying again.', { cause });
  }
}

// Adding to a position that's down: Perpl checks the whole position against
// the market's initial margin, and this order doesn't bring enough to cover
// the loss. Retrying can't help, so the engine doesn't.
export class UnderwaterError extends FundsError {}
