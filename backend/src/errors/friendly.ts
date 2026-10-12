// What members read when something fails. Venue and engine errors carry order
// codes, ids and hashes that mean nothing to a member, so every failure that
// reaches the app goes through here: a plain sentence saying what happened and
// what to do, plus a stable `code` the app can switch on. The raw detail stays
// in the server logs.

export interface Friendly {
  code: string;
  message: string;
}

// Monad's public testnet faucet: free MON for network fees. There's no gas
// top-up from Cult, so a wallet with no MON is pointed here on testnet.
export const TESTNET_FAUCET_URL = 'https://faucet.monad.xyz';

export function gasMessage(chainId = Number(process.env.PERPL_CHAIN_ID || 10143)): string {
  return chainId === 143
    ? 'Your wallet needs a little MON for network fees. Deposit some MON, then try again.'
    : 'Your wallet needs a little MON for network fees. Get free testnet MON at faucet.monad.xyz, then try again.';
}

// Perpl's OrderStatusReason (`sr`) and OrderFailureReason (`fr`), from
// https://docs.perpl.xyz/resources/for-developers/api/types-and-errors
const SR = {
  AmountExceedsAvailableBalance: 1,
  AccountFrozen: 2,
  CloseOrderExceedsPosition: 10,
  CloseOrderPositionMismatch: 11,
  ContractNotOperational: 12,
  ExceedsLastExecutionBlock: 14,
  ForwardingReverted: 15,
  ImmediateOrCancelExecuted: 16,
  ImmediateOrderUnderMinimum: 17,
  InsuficientFundsForRecycleFee: 18,
  InvalidAccountFrozenOrder: 19,
  MakerOrderSettlementFailed: 23,
  MaximumAccountOrders: 24,
  MaxMatchesReached: 25,
  OrderBookFull: 27,
  OrderDescIdTooLow: 32,
  OrderPostFailed: 36,
  OrderSettlementImpliesInsolvent: 37,
  OrderSizeExceedsAvailableSize: 38,
  PostOrderUnderMinimum: 39,
  PriceOutOfRange: 40,
  RecycleBalanceInsufficientSevere: 41,
  SizeOutOfRange: 42,
  TakerOrderSettlementFailed: 44,
  UnmatchedLotRemainsInFillOrKill: 46,
  PerpetualInsolvent: 53,
  InvalidAmount: 55,
  InvalidTriggerOrder: 57,
  WrongTriggerPosition: 58,
  ValueExceedsMaximum: 61,
} as const;

const FR = {
  InsufficientBalance: 1,
  InsufficientCollateralIncrease: 2,
  InsufficientCollateralInvert: 3,
  NoPositionToClose: 4,
  PerpetualSolvency: 5,
  NegativePositionValue: 6,
  ReferencePriceStale: 7,
  ExceedsMaxNegPnlCollat: 8,
} as const;

export const NEEDS_MARGIN: Friendly = {
  code: 'needs_margin',
  message: 'Not enough $ in your trading account for this trade. Add funds or use a smaller amount.',
};
const UNDERWATER: Friendly = {
  code: 'needs_margin',
  message: 'Your open position on this market is down, so adding to it needs more margin. Add funds, lower the leverage, or close the position first.',
};
const NO_FILL: Friendly = {
  code: 'no_fill',
  message: "There wasn't enough on the market to fill this at a fair price. Try a smaller amount or try again in a moment.",
};
const PRICE_MOVED: Friendly = {
  code: 'price_moved',
  message: 'The price moved before your order could fill. Try again.',
};
const TOO_SMALL: Friendly = {
  code: 'too_small',
  message: 'This trade is below the minimum size for this market. Use a larger amount.',
};
const TOO_BIG: Friendly = {
  code: 'too_big',
  message: 'This trade is larger than this market allows right now. Use a smaller amount.',
};
const POSITION_CHANGED: Friendly = {
  code: 'position_changed',
  message: 'This position has already changed or closed. Refresh your positions and try again.',
};
const MARKET_PAUSED: Friendly = {
  code: 'market_paused',
  message: 'This market is paused on the exchange right now. Try again later.',
};
const ACCOUNT_LOCKED: Friendly = {
  code: 'account_locked',
  message: 'The exchange has temporarily locked your trading account. Try again later.',
};
const TOO_MANY_ORDERS: Friendly = {
  code: 'too_many_orders',
  message: 'You have too many open orders on this market. Cancel a take-profit or stop-loss and try again.',
};
const EXCHANGE_REFUSED: Friendly = {
  code: 'order_failed',
  message: "The exchange didn't accept this order. Try again in a moment.",
};

// One Perpl order failure in plain words. `filled` = some of it went through,
// so "try again" would risk doubling up: send them to their positions instead.
export function perplOrderProblem(sr: number, fr?: number | null, filled = false): Friendly {
  if (filled) {
    return { code: 'order_partial', message: 'Only part of this order filled before the exchange stopped it. Check your open positions before trading again.' };
  }
  if (sr === SR.TakerOrderSettlementFailed || sr === SR.MakerOrderSettlementFailed || sr === SR.OrderPostFailed) {
    switch (fr) {
      case FR.InsufficientBalance:
      case FR.InsufficientCollateralInvert:
        return NEEDS_MARGIN;
      case FR.InsufficientCollateralIncrease:
      case FR.NegativePositionValue:
      case FR.ExceedsMaxNegPnlCollat:
        return UNDERWATER;
      case FR.NoPositionToClose:
        return POSITION_CHANGED;
      case FR.PerpetualSolvency:
      case FR.ReferencePriceStale:
        return MARKET_PAUSED;
      default:
        return EXCHANGE_REFUSED;
    }
  }
  switch (sr) {
    case SR.AmountExceedsAvailableBalance:
    case SR.InsuficientFundsForRecycleFee:
    case SR.RecycleBalanceInsufficientSevere:
    case SR.OrderSettlementImpliesInsolvent:
      return NEEDS_MARGIN;
    case SR.ImmediateOrCancelExecuted:
    case SR.OrderSizeExceedsAvailableSize:
    case SR.MaxMatchesReached:
    case SR.UnmatchedLotRemainsInFillOrKill:
      return NO_FILL;
    case SR.PriceOutOfRange:
    case SR.ExceedsLastExecutionBlock:
      return PRICE_MOVED;
    case SR.ImmediateOrderUnderMinimum:
    case SR.PostOrderUnderMinimum:
    case SR.InvalidAmount:
      return TOO_SMALL;
    case SR.SizeOutOfRange:
    case SR.ValueExceedsMaximum:
      return TOO_BIG;
    case SR.CloseOrderExceedsPosition:
    case SR.CloseOrderPositionMismatch:
    case SR.WrongTriggerPosition:
      return POSITION_CHANGED;
    case SR.ContractNotOperational:
    case SR.PerpetualInsolvent:
      return MARKET_PAUSED;
    case SR.AccountFrozen:
    case SR.InvalidAccountFrozenOrder:
      return ACCOUNT_LOCKED;
    case SR.MaximumAccountOrders:
    case SR.OrderBookFull:
      return TOO_MANY_ORDERS;
    default:
      return EXCHANGE_REFUSED;
  }
}

// Internal messages the engine, venues and funding code produce, matched to
// what the member should read. First match wins.
const RULES: [RegExp, Friendly][] = [
  [/insufficient (balance|funds)|INSUFFICIENT_FUNDS|top up MON|for (gas|network fees)/i, { code: 'needs_gas', get message() { return gasMessage(); } }],
  [/interrupted by a restart/i, { code: 'restarted', message: 'Cult restarted before your copy went out, so it was skipped. Nothing was traded.' }],
  [/detected \d+s late|at a stale price/i, { code: 'too_late', message: 'This trade reached us too late to copy at a fair price, so it was skipped.' }],
  [/leader (already )?closed|before mirror fired|exit covers it/i, { code: 'leader_closed', message: 'The trader closed this before your copy went out, so it was skipped.' }],
  [/no Privy wallet|unknown member|has no Perpl account|Perpl credentials unavailable|Perpl setup not finished|finish Perpl setup|Set up perps first/i, { code: 'needs_setup', message: 'Finish setting up perps in the app first, then try again.' }],
  [/Allow Cult to fund|trading signer|backend signer|outdated policy|re-approve|Trading permission refused|PermissionDenied|policy (violation|denied)|funding limit/i, { code: 'needs_permission', message: 'Cult needs your trading permission for this. Renew it in the app, then try again.' }],
  [/rounds to (0|\$0|nothing)|under the \$[\d.]+ minimum|below the minimum/i, TOO_SMALL],
  [/did not fill/i, NO_FILL],
  [/mirroring is disabled|turned off Follow exits|Auto-follow is off/i, { code: 'copy_off', message: 'Copying is off for this cult, so this trade was skipped.' }],
  [/no longer in the clan|not a member|left the clan/i, { code: 'not_member', message: "You're no longer in this cult, so this trade was skipped." }],
  [/changed direction|opposite-side|position status is unconfirmed|size is unconfirmed|already exited|no open position|^mirror is \w+$/i, POSITION_CHANGED],
  [/no mark price|stale/i, { code: 'price_unavailable', message: "We couldn't get a live price for this market. Try again in a moment." }],
  [/swapp(ed|ing).*(failed|MON is)|MON swap returned less/i, { code: 'swap_failed', message: "The swap for this trade didn't finish. Your funds are safe in your wallet. Try again." }],
  [/Couldn't swap|SwapUnavailable|Kuru/i, { code: 'swap_unavailable', message: "We couldn't swap for this trade right now. Try again shortly." }],
  [/position is down|near its margin limit/i, UNDERWATER],
  [/not enough funds|needs \$[\d.]+ (of testnet dollars|more)/i, NEEDS_MARGIN],
  [/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timeout|unreachable|HTTP 5\d\d/i, { code: 'service_unavailable', message: "The exchange isn't responding right now. Try again in a minute." }],
];

// A Perpl order failure as our own error classes print it (OrderFailed,
// TpSlError) or as older rows stored it: "... st=7 sr=44 fr=2".
const ORDER_CODES = /\bsr=(\d+)(?:\s+fr=(\d+|-))?/;

export function explain(raw: unknown): Friendly | null {
  const text = raw instanceof Error ? raw.message : String(raw ?? '');
  if (!text) return null;
  const codes = ORDER_CODES.exec(text);
  if (codes) return perplOrderProblem(Number(codes[1]), codes[2] && codes[2] !== '-' ? Number(codes[2]) : null);
  for (const [pattern, friendly] of RULES) if (pattern.test(text)) return friendly;
  return null;
}

// Does this read like a programmer wrote it for a programmer?
export function looksTechnical(text: string): boolean {
  return /Error:|0x[0-9a-f]{6,}|\b(rq|st|sr|fr|acc|mkt|oid)=|revert|HTTP \d{3}|undefined|null|NaN|\bat \w+ \(|stack|exception|\bwei\b/i.test(text);
}

// Why a copy (auto-mirror, add, partial exit or stack) didn't run, for the
// member whose copy it was.
export const COPY_FALLBACK: Friendly = {
  code: 'copy_failed',
  message: "Your copy didn't go through, and nothing was traded.",
};
// Sent to the exchange but not confirmed: we can't promise nothing traded.
export const COPY_UNCONFIRMED: Friendly = {
  code: 'copy_unconfirmed',
  message: "We couldn't confirm your copy. Check your open positions before trading again.",
};

export function explainCopy(raw: string | null | undefined, sent = false): Friendly {
  const known = explain(raw);
  if (known) return known;
  return sent ? COPY_UNCONFIRMED : COPY_FALLBACK;
}

// A mirror or adjustment row as its member sees it: `error` in plain words
// plus `errorCode`. The stored row keeps the raw reason for the logs and the
// engine's own checks.
export function memberView<T extends { status: string; error: string | null }>(row: T): T & { errorCode: string | null } {
  const raw = row.error;
  if (!raw) return { ...row, errorCode: null };
  // Read by the app as-is: the member's own choice, not a failure.
  if (raw === 'member turned off Follow exits') return { ...row, errorCode: 'exits_off' };
  if (/^retrying \(/.test(raw)) return { ...row, error: 'Retrying your copy.', errorCode: 'retrying' };
  if (/^capped: /.test(raw)) return { ...row, error: 'Sized down to fit your copy limits.', errorCode: 'capped' };
  if (row.status === 'failed') {
    const why = explainCopy(raw, /after sending/i.test(raw));
    return { ...row, error: why.message, errorCode: why.code };
  }
  const known = explain(raw);
  if (known) return { ...row, error: known.message, errorCode: known.code };
  return { ...row, error: looksTechnical(raw) ? null : raw, errorCode: null };
}

// "slow down a little" -> "Slow down a little."
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?)]$/.test(s) ? s : `${s}.`;
}
