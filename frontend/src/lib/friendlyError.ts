type CodedError = { code?: unknown; errorCode?: unknown; message?: unknown; error?: unknown; status?: unknown; retryAfterSeconds?: unknown };

const messages: Record<string, string> = {
  needs_margin: 'Your trading account needs more dollars for this trade. Add funds and try again.',
  needs_funds: 'Your wallet does not have enough dollars for this trade. Deposit and try again.',
  needs_gas: 'Your wallet needs more MON for network fees. Add MON and try again.',
  needs_permission: 'Your trading permission needs renewing. Allow Cult to place trades, then try again.',
  needs_setup: 'Perps are not enabled yet. Complete the one-time setup and try again.',
  no_fill: 'This order could not be filled. Check the current price and try again.',
  price_moved: 'The price moved before your order filled. Check the new price and try again.',
  too_small: 'This order is below the market minimum. Increase the amount and try again.',
  too_big: 'This order is above the market limit. Reduce the amount and try again.',
  position_changed: 'Your position changed while the order was processing. Refresh positions before trying again.',
  market_paused: 'Trading is paused for this market. Try another market or come back later.',
  account_locked: 'Trading is unavailable for this account. Check your account before placing another trade.',
  too_many_orders: 'Too many orders are in progress. Wait a moment and try again.',
  order_failed: 'This trade did not go through. Check your balance and open positions before trying again.',
  order_partial: 'Only part of this trade filled. Check Open positions before doing anything else.',
  unsupported_leverage: 'This leverage is not available for the market. Choose a lower setting and try again.',
  price_unavailable: 'A current price is unavailable. Wait a moment and try again.',
  swap_failed: 'The conversion did not complete. Check your balance before trying again.',
  swap_unavailable: 'Conversion is unavailable right now. Try again shortly.',
  service_unavailable: 'Trading is temporarily unavailable. Try again shortly.',
  bet_refused: 'This bet was not accepted. Check the market and try again.',
  copy_failed: 'Your copy did not go through. Check your balance and trading permissions before trying again.',
  copy_unconfirmed: 'Your copy has not been confirmed. Check Open positions before trying again.',
  copy_off: 'Auto-follow is off for this cult. Turn it on to copy new trades.',
  not_member: 'You are no longer in this cult. Rejoin before copying its trades.',
  too_late: 'The skip window has ended. Check your Open positions for the result.',
  leader_closed: 'The sender already closed this trade. Check your Open positions before copying another.',
  restarted: 'This copy was interrupted. Check Open positions before trying again.',
  retrying: 'Your copy is still being retried. Check its status in this cult.',
  capped: 'This copy reached your limit. Increase your auto-follow cap to copy more.',
  exits_off: 'Follow exits is off. Close this copy yourself from Open positions.',
  invalid_request: 'Those details could not be used. Check them and try again.',
  internal: 'Something went wrong while processing this request. Try again shortly.',
};

const technical = /\b(?:Error\s*:|undefined\b|null\b|revert(?:ed)?\b|contract\b|rpc\b|HTTP\s*\d{3}\b|status\s*\d{3}\b)|\b(?:rq|st|sr|fr)=\S+|0x[0-9a-f]{8,}/i;
const action = /\b(?:try|check|refresh|add|enable|choose|select|turn|sign|open|wait|deposit|contact|review|switch|rejoin|reduce|increase|use|enter|allow|confirm|start|pick)\b|come back/i;

export function friendlyError(reason: unknown, fallback = 'Something went wrong. Try again shortly.'): string {
  const value = reason && typeof reason === 'object' ? reason as CodedError : null;
  const code = typeof value?.code === 'string' ? value.code : typeof value?.errorCode === 'string' ? value.errorCode : null;
  if (code && messages[code]) return messages[code];

  const raw = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message
    : typeof value?.message === 'string' ? value.message : typeof value?.error === 'string' ? value.error : '';
  if (/user rejected|user denied|rejected the request|request rejected|popup closed|user cancelled|user canceled|modal closed/i.test(raw))
    return 'Wallet approval was cancelled. Try again when you are ready.';
  if (/insufficient (funds|balance)|not enough .*gas|gas required/i.test(raw))
    return 'Your wallet needs more MON for network fees. Add MON and try again.';
  if (/wrong network|chain mismatch|unsupported chain|switch.*network/i.test(raw))
    return 'Your wallet is on the wrong network. Switch to the network shown in Cult and try again.';
  if (/network error|failed to fetch|rpc|timeout|timed out|connection failed/i.test(raw))
    return 'The connection to trading services failed. Check your connection and try again.';
  if (value?.status === 429) {
    const seconds = typeof value.retryAfterSeconds === 'number' && value.retryAfterSeconds > 0 ? ` in ${Math.ceil(value.retryAfterSeconds)}s` : ' shortly';
    return `Too many requests. Try again${seconds}.`;
  }
  if (value?.status === 401 || value?.status === 403) return 'Your session needs refreshing. Sign in again to continue.';
  if (value?.status === 503) return 'This service is temporarily unavailable. Try again shortly.';
  if (!raw.trim() || technical.test(raw) || /[\r\n{}<>]/.test(raw)) return fallback;
  return action.test(raw) ? raw.trim() : `${raw.trim()} Try again shortly.`;
}
