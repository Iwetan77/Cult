// The member doesn't hold enough for what they asked. The API answers 409 with
// the message, which says what's needed.
export class FundsError extends Error {}
