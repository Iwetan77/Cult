// The member doesn't hold enough for what they asked. The API answers 409 with
// the message, which says what's needed.
export class FundsError extends Error {}

export class FundingAuthorizationError extends FundsError {
  constructor(cause: Error) {
    super('Trading permission refused the funding transaction. Renew trading permission in the app, then check your trading balance before trying again.', { cause });
  }
}
