import type { FlowStep, IntentChain, IntentStatus, IntentSwap, IntentWithdraw, PredictionAccount, PredictionFundPlan, PredictionRedeem, WithdrawPrepared } from './contracts';
import type { BackendConfig, ChatMessage, Reaction, ChatPage, ChatRoom, ChartSnapshot, Clan, CultStanding, DepositInfo, DiscoverCult, BoardPeriod, Leaderboard, EnrollmentChallenge, Fill, FundingPlan, Home, Profile, FundingResult, Holding, WithdrawRequest, WithdrawResult, PredictionBet, PredictionClosed, PredictionOrder, PredictionPosition, PredictionSale, MarketDetail, MarketListing, Me, MirrorPolicy, NadMarket, PrivySignerGrant, PublicShare, SetupStatus, ShareResult, SignedChallenge, StackResult, TradeView, TpslSuggestion, TpslValues, Venue } from './contracts';
import { rememberList, rememberMarket } from './marketCache';
import { DemoError, demoApi, isDemo } from './demo';

const BASE = process.env.NEXT_PUBLIC_CULT_API_BASE_URL;

export class ApiError extends Error {
  // code: a machine-readable reason some routes add (e.g. 'needs_setup', 'needs_funds').
  constructor(message: string, readonly status: number, readonly retryAfterSeconds: number | null = null, readonly code: string | null = null) { super(message); }
}

export async function api<T>(path: string, token: string | null, options: RequestInit = {}): Promise<T> {
  if (isDemo()) {
    try { return await demoApi<T>(path, options, () => request<T>(path, null, options)); }
    catch (reason) { throw reason instanceof DemoError ? new ApiError(reason.message, reason.status) : reason; }
  }
  return request<T>(path, token, options);
}

async function request<T>(path: string, token: string | null, options: RequestInit): Promise<T> {
  if (!BASE) throw new ApiError('Backend API is not configured yet.', 503);
  const response = await fetch(`${BASE.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; code?: string };
    const message = body.message ?? `Request failed (${response.status})`;
    if (response.status === 503 && path === '/v1/positions/open') {
      throw new ApiError("Couldn't swap for this trade right now. Try again shortly.", 503);
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null;
      throw new ApiError(seconds == null ? 'Slow down, try again shortly.' : `Slow down, try again in ${seconds}s.`, 429, seconds);
    }
    throw new ApiError(response.status === 503 && !/retry/i.test(message) ? `${message} Retry shortly.` : message, response.status, null, body.code ?? null);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (value: unknown) => JSON.stringify(value);
export const getConfig = () => api<BackendConfig>('/v1/config', null);
export const getMe = (token: string) => api<Me>('/v1/me', token);
export const getPrivySigner = (token: string) => api<PrivySignerGrant>('/v1/privy/signer', token);
export const getNadMarkets = (token: string) => api<{ markets: NadMarket[] }>('/v1/nadfun/markets?order=latest_trade', token);
export const getHoldings = (token: string) => api<{ positions: Holding[] }>('/v1/positions', token);
// cultIds is "Post to": omitted = all your cults, [] = just you.
export const openPosition = (token: string, marketId: string, side: 'long' | 'short' | 'buy', marginUsd: number, leverage?: number, cultIds?: string[]) => api<Fill>('/v1/positions/open', token, { method: 'POST', body: json({ marketId, side, marginUsd, ...(leverage ? { leverage } : {}), ...(cultIds ? { cultIds } : {}) }) });
// sizeRaw closes part of the position (raw size units, from Holding.sizeRaw); omitted closes it all.
export const closePosition = (token: string, marketId: string, sizeRaw?: string) => api<Fill>('/v1/positions/close', token, { method: 'POST', body: json(sizeRaw ? { marketId, sizeRaw } : { marketId }) });
// image: the cult's picture as a data URL (lib/image squareImage), optional.
export const createClan = (token: string, name: string, visibility: 'private' | 'public', image?: string) => api<Clan>('/v1/cults', token, { method: 'POST', body: json({ name, visibility, ...(image ? { image } : {}) }) });
// An admin changes the cult's picture; null takes it off (back to the letter).
export const setCultImage = (token: string, cultId: string, image: string | null) => api<Clan>(`/v1/cults/${encodeURIComponent(cultId)}/image`, token, { method: 'POST', body: json({ image }) });
export const getJoinChallenge = (token: string, target: { inviteCode: string } | { cultId: string }, policy: MirrorPolicy) => api<SignedChallenge>('/v1/cults/join/challenge', token, { method: 'POST', body: json({ ...target, policy }) });
export const joinClan = (token: string, target: { inviteCode: string } | { cultId: string }) => api<Clan>('/v1/cults/join', token, { method: 'POST', body: json(target) });
export const getPolicyChallenge = (token: string, clanId: string, policy: MirrorPolicy) => api<SignedChallenge>(`/v1/cults/${encodeURIComponent(clanId)}/policy/challenge`, token, { method: 'POST', body: json({ policy }) });
export const updateClanPolicy = (token: string, clanId: string, challengeId: string, signature: string) => api<Clan>(`/v1/cults/${encodeURIComponent(clanId)}/policy`, token, { method: 'POST', body: json({ challengeId, signature }) });
export const leaveClan = (token: string, clanId: string) => api<void>(`/v1/cults/${encodeURIComponent(clanId)}/leave`, token, { method: 'POST' });
export const getClanMessages = (token: string, clanId: string, before?: string) => api<ChatPage>(`/v1/cults/${encodeURIComponent(clanId)}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`, token);
export const sendClanMessage = (token: string, clanId: string, body: string, replyTo?: string, markerId?: string) => api<ChatMessage>(`/v1/cults/${encodeURIComponent(clanId)}/messages`, token, { method: 'POST', body: json({ body, ...(replyTo ? { replyTo } : {}), ...(markerId ? { markerId } : {}) }) });
export const getChart = (token: string, clanId: string, marketId?: string, resolutionSec?: number) => api<ChartSnapshot>(`/v1/cults/${encodeURIComponent(clanId)}/chart?${new URLSearchParams({ ...(marketId ? { marketId } : {}), ...(resolutionSec ? { resolution: String(resolutionSec) } : {}) })}`, token);
export const getClanEventUrl = (clanId: string) => {
  if (!BASE) throw new ApiError('Backend API is not configured yet.', 503);
  return `${BASE.replace(/\/$/, '')}/v1/cults/${encodeURIComponent(clanId)}/events`;
};
export const setPositionTpsl = (token: string, marketId: string, values: TpslValues) => api<{ takeProfit: number | null; stopLoss: number | null }>('/v1/positions/tpsl', token, { method: 'POST', body: json({ marketId, ...values }) });
export const suggestMarkerTpsl = (token: string, clanId: string, markerId: string, values: TpslValues) => api<TpslSuggestion>(`/v1/cults/${encodeURIComponent(clanId)}/markers/${encodeURIComponent(markerId)}/suggest-tpsl`, token, { method: 'POST', body: json(values) });
export const getPerplSetup = (token: string) => api<SetupStatus>('/v1/perpl/setup', token);
export const getEnrollmentChallenge = (token: string) => api<EnrollmentChallenge>('/v1/enrollment/perpl/challenge', token, { method: 'POST' });
export const enrollPerpl = (token: string, challengeId: string, signature: string) => api<void>('/v1/enrollment/perpl', token, { method: 'POST', body: json({ challengeId, signature }) });
export const skipAutoMirror = (token: string, clanId: string, markerId: string) => api<void>(`/v1/cults/${encodeURIComponent(clanId)}/mirrors/${encodeURIComponent(markerId)}/skip`, token, { method: 'POST' });
// Only the owner grants or removes admin roles (admins share trades too).
export const setCultAdmin = (token: string, clanId: string, memberId: string, admin: boolean) => api<{ memberId: string; admin: boolean }>(`/v1/cults/${encodeURIComponent(clanId)}/admins`, token, { method: 'POST', body: json({ memberId, admin }) });
export const stackPosition = (token: string, clanId: string, markerId: string, notionalUsd: number) => api<StackResult>(`/v1/cults/${encodeURIComponent(clanId)}/stack`, token, { method: 'POST', body: json({ markerId, notionalUsd }) });
export const prepareUsdcFunding = (token: string, amountUsdc: string, depositToPerpl: boolean) => api<FundingPlan>('/v1/funding/usdc/prepare', token, { method: 'POST', body: json({ amountUsdc, depositToPerpl }) });
export const confirmUsdcFunding = (token: string, planId: string, hashes: string[]) => api<FundingResult>('/v1/funding/usdc/confirm', token, { method: 'POST', body: json({ planId, hashes }) });
export const createShare = (token: string, markerId: string, includeClan: boolean) => api<ShareResult>('/v1/shares', token, { method: 'POST', body: json({ markerId, includeClan }) });
export const getPublicShare = (id: string) => api<PublicShare>(`/v1/shares/${encodeURIComponent(id)}`, null);

export const discoverCults = (token: string) => api<{ cults: DiscoverCult[] }>('/v1/cults/discover', token);
export const setCultVisibility = (token: string, cultId: string, visibility: 'private' | 'public') => api<Clan>(`/v1/cults/${encodeURIComponent(cultId)}/visibility`, token, { method: 'POST', body: json({ visibility }) });
export const setCountry = (token: string, country: string) => api<{ country: { code: string; name: string }; rooms: ChatRoom[] }>('/v1/me/country', token, { method: 'POST', body: json({ country }) });
export const getRooms = (token: string) => api<{ rooms: ChatRoom[] }>('/v1/chat/rooms', token);
export const getRoomMessages = (token: string, room: string, before?: string) => api<ChatPage>(`/v1/chat/${encodeURIComponent(room)}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`, token);
// image: a photo (data URL, lib/image fittedImage); the body is then its caption and may be empty.
export const sendRoomMessage = (token: string, room: string, body: string, replyTo?: string, markerId?: string, image?: string) => api<ChatMessage>(`/v1/chat/${encodeURIComponent(room)}/messages`, token, { method: 'POST', body: json({ body, ...(replyTo ? { replyTo } : {}), ...(markerId ? { markerId } : {}), ...(image ? { image } : {}) }) });
// Who's typing: the demo shows it; live rooms get it once the backend sends
// typing events. (Reactions, photos and cult pictures work everywhere.)
export const hasTyping = () => isDemo();
// Pictures the API serves (chat photos, cult pictures) come as /v1 paths;
// data URLs (just picked, or from the demo) are used as they are.
export const mediaUrl = (url: string | null | undefined) => {
  if (!url) return null;
  if (!url.startsWith('/')) return url;
  return BASE ? `${BASE.replace(/\/$/, '')}${url}` : null;
};
export const reactToMessage = (token: string, room: string, messageId: string, emoji: string) => api<{ reactions: Reaction[] }>(`/v1/chat/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}/reactions`, token, { method: 'POST', body: json({ emoji }) });
export const getTyping = (token: string, room: string) => api<{ names: string[] }>(`/v1/chat/${encodeURIComponent(room)}/typing`, token);
export const getRoomEventUrl = (room: string) => {
  if (!BASE) throw new ApiError('Backend API is not configured yet.', 503);
  return `${BASE.replace(/\/$/, '')}/v1/chat/${encodeURIComponent(room)}/events`;
};
export const getLeaderboard = (token: string, scope: 'global' | 'country' | 'cult', cultId?: string, period: BoardPeriod = 'all') => api<Leaderboard>(`${scope === 'global' ? '/v1/leaderboards/global' : scope === 'country' ? '/v1/leaderboards/country' : `/v1/cults/${encodeURIComponent(cultId ?? '')}/leaderboard`}${period === 'all' ? '' : `?period=${period}`}`, token);
export const getCultStandings = (token: string) => api<{ entries: CultStanding[]; asOf: string }>('/v1/leaderboards/cults', token);

export const setAutoFollowOff = (token: string, cultId: string) => api<Clan>(`/v1/cults/${encodeURIComponent(cultId)}/auto-follow`, token, { method: 'POST', body: json({ enabled: false }) });
export const pinRoomMessage = (token: string, room: string, messageId: string | null) => api<{ pinned: ChatPage['pinned'] }>(`/v1/chat/${encodeURIComponent(room)}/pin`, token, { method: 'POST', body: json({ messageId }) });
export const getHome = (token: string) => api<Home>('/v1/home', token);
export const getProfile = (token: string, idOrWallet: string) => api<Profile>(`/v1/members/${encodeURIComponent(idOrWallet)}`, token);
export const getTrade = (token: string, tradeId: string) => api<TradeView>(`/v1/trades/${encodeURIComponent(tradeId)}`, token);

export const usernameAvailability = (name: string) => api<{ available: boolean; reason?: string }>(`/v1/usernames/${encodeURIComponent(name)}`, null);
export const setUsername = (token: string, username: string) => api<{ username: string; name: string }>('/v1/me/username', token, { method: 'POST', body: json({ username }) });
// The member's 4-digit PIN: set it (a change needs the current one), or reset
// a forgotten one right after signing in again.
export const setPin = (token: string, pin: string, currentPin?: string) => api<{ pinSet: true }>('/v1/me/pin', token, { method: 'POST', body: json({ pin, ...(currentPin ? { currentPin } : {}) }) });
// MON for network fees, topped up by Cult's gas wallet when the member has none.
export const ensureGas = (token: string) => api<{ mon: number; topped: boolean; reason?: string }>('/v1/wallet/gas', token, { method: 'POST' });
export const resetPin = (token: string, pin: string) => api<{ pinSet: true }>('/v1/me/pin/reset', token, { method: 'POST', body: json({ pin }) });
export const uploadAvatar = (token: string, image: string) => api<{ avatarUrl: string }>('/v1/me/avatar', token, { method: 'POST', body: json({ image }) });
export const deleteAvatar = (token: string) => api<void>('/v1/me/avatar', token, { method: 'DELETE' });
export const getPushConfig = (token: string) => api<{ publicKey: string }>('/v1/notifications/push', token);
export const savePushSubscription = (token: string, subscription: PushSubscriptionJSON) => api<void>('/v1/notifications/push', token, { method: 'POST', body: json(subscription) });
export const deletePushSubscription = (token: string, endpoint: string, signal?: AbortSignal) => api<void>('/v1/notifications/push', token, { method: 'DELETE', body: json({ endpoint }), signal });
export const testPhonePush = (token: string) => api<void>('/v1/notifications/push/test', token, { method: 'POST' });
// Prediction markets: market data comes straight from Polymarket
// (lib/polymarket.ts); bets go through the backend (Polymarket account per
// member). The demo answers locally. Steps the member's wallet must sign come
// back as a FlowStep (see runFlow in Dashboard).
export const PREDICTIONS_SOON = 'Prediction trading is coming to Cult soon. Try it in the demo.';
export const isFlowStep = <T,>(value: T | FlowStep<T>): value is FlowStep<T> =>
  !!value && typeof value === 'object' && 'status' in value && 'flowId' in value && ['needs_signature', 'working', 'done'].includes(String((value as { status: unknown }).status));
const DEMO_PREDICTION_ACCOUNT: PredictionAccount = { enabled: true, step: 'ready', reason: null, wallet: null, balanceUsd: null, signsEachBet: false, funding: null, access: { country: null, predictions: 'open', perps: 'open' } };
export const getPredictionAccount = (token: string) => isDemo() ? Promise.resolve(DEMO_PREDICTION_ACCOUNT) : api<PredictionAccount>('/v1/predictions/account', token);
export const setupPredictions = (token: string) => api<FlowStep<PredictionAccount>>('/v1/predictions/setup', token, { method: 'POST' });
export const signFlowStep = (token: string, flowId: string, challengeId: string, signature: string) => api<FlowStep<unknown>>('/v1/predictions/sign', token, { method: 'POST', body: json({ flowId, challengeId, signature }) });
export const pollFlow = (token: string, flowId: string) => api<FlowStep<unknown>>(`/v1/predictions/flows/${encodeURIComponent(flowId)}`, token);
export const fundPredictions = (token: string, amountUsd: number) => api<PredictionFundPlan>('/v1/predictions/fund', token, { method: 'POST', body: json({ amountUsd }) });
export const withdrawPredictions = (token: string, amountUsd: number) => api<FlowStep<{ amountUsd: number; tx: string | null; seconds: number }>>('/v1/predictions/withdraw', token, { method: 'POST', body: json({ amountUsd }) });
export const redeemPrediction = (token: string, positionId: string) => api<FlowStep<PredictionRedeem>>('/v1/predictions/redeem', token, { method: 'POST', body: json({ positionId }) });
export const getPredictionPositions = (token: string) => api<{ positions: PredictionPosition[]; closed: PredictionClosed[]; redeemable?: string[] }>('/v1/predictions/positions', token);
export const buyPrediction = (token: string, order: PredictionOrder) => api<PredictionPosition | FlowStep<PredictionPosition>>('/v1/predictions/orders', token, { method: 'POST', body: json(order) });
export const sellPrediction = (token: string, positionId: string, price: number) => api<PredictionSale | FlowStep<PredictionSale>>('/v1/predictions/sell', token, { method: 'POST', body: json({ positionId, price }) });
export const getPredictionBets = (token: string, eventSlug: string, outcomes: { id: string; label: string; yesPrice: number; yesLabel: string; noLabel: string }[]) =>
  api<{ bets: PredictionBet[] }>('/v1/predictions/bets', token, { method: 'POST', body: json({ eventSlug, outcomes }) });
export const getDeposit = (token: string) => api<DepositInfo>('/v1/wallet/deposit', token);
// The backend can't move funds out by design: it answers with the send for
// the member's own wallet to sign (the demo answers with a finished one).
export const withdraw = (token: string, body: WithdrawRequest) => api<WithdrawResult | WithdrawPrepared>('/v1/wallet/withdraw', token, { method: 'POST', body: JSON.stringify(body) });
// Cross-chain money in/out (Aurora Intents, Monad mainnet).
export const getIntentChains = (token: string) => api<{ enabled: boolean; chains: IntentChain[] }>('/v1/intents/chains', token);
export const quoteIntentDeposit = (token: string, originAsset: string, amount: string, refundTo?: string) => api<IntentSwap>('/v1/intents/deposit', token, { method: 'POST', body: json({ originAsset, amount, ...(refundTo ? { refundTo } : {}) }) });
export const prepareIntentWithdraw = (token: string, destinationAsset: string, amountUsd: number, recipient: string, pin?: string) => api<IntentWithdraw>('/v1/intents/withdraw', token, { method: 'POST', body: json({ destinationAsset, amountUsd, recipient, ...(pin ? { pin } : {}) }) });
export const getIntentStatus = (token: string, depositAddress: string) => api<IntentStatus>(`/v1/intents/status/${encodeURIComponent(depositAddress)}`, token);
export const submitIntentDeposit = (token: string, depositAddress: string, txHash: string) => api<void>('/v1/intents/submit', token, { method: 'POST', body: json({ depositAddress, txHash }) });
export const getMarkets = (query = '', venue?: Venue) => api<{ markets: MarketListing[] }>(`/v1/markets?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(venue ? { venue } : {}), limit: '100' })}`, null)
  .then(r => { rememberList(query, venue, r.markets); return r; });
export const getMarket = (id: string, resolutionSec = 3600) => api<MarketDetail>(`/v1/markets/${encodeURIComponent(id)}?resolution=${resolutionSec}`, null)
  .then(d => { rememberMarket(d); return d; });
