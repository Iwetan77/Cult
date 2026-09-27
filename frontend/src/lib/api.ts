import type { BackendConfig, ChatMessage, ChatPage, ChartSnapshot, Clan, EnrollmentChallenge, Fill, FundingPlan, FundingResult, Holding, Me, MirrorPolicy, NadMarket, PrivySignerGrant, PublicShare, SetupStatus, ShareResult, SignedChallenge, StackResult, TpslSuggestion, TpslValues } from './contracts';

const BASE = process.env.NEXT_PUBLIC_CULT_API_BASE_URL;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds: number | null = null) { super(message); }
}

export async function api<T>(path: string, token: string | null, options: RequestInit = {}): Promise<T> {
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
    const body = await response.json().catch(() => ({})) as { message?: string };
    const message = body.message ?? `Request failed (${response.status})`;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null;
      throw new ApiError(seconds == null ? 'Slow down, try again shortly.' : `Slow down, try again in ${seconds}s.`, 429, seconds);
    }
    throw new ApiError(response.status === 503 && !/retry/i.test(message) ? `${message} Retry shortly.` : message, response.status);
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
export const openPosition = (token: string, marketId: string, side: 'long' | 'short' | 'buy', marginUsd: number, leverage?: number) => api<Fill>('/v1/positions/open', token, { method: 'POST', body: json({ marketId, side, marginUsd, ...(leverage ? { leverage } : {}) }) });
export const closePosition = (token: string, marketId: string) => api<Fill>('/v1/positions/close', token, { method: 'POST', body: json({ marketId }) });
export const createClan = (token: string, name: string, policy: MirrorPolicy) => api<Clan>('/v1/clans', token, { method: 'POST', body: json({ name, policy }) });
export const getJoinChallenge = (token: string, inviteCode: string, policy: MirrorPolicy) => api<SignedChallenge>('/v1/clans/join/challenge', token, { method: 'POST', body: json({ inviteCode, policy }) });
export const joinClan = (token: string, challengeId: string, signature: string) => api<Clan>('/v1/clans/join', token, { method: 'POST', body: json({ challengeId, signature }) });
export const getPolicyChallenge = (token: string, clanId: string, policy: MirrorPolicy) => api<SignedChallenge>(`/v1/clans/${encodeURIComponent(clanId)}/policy/challenge`, token, { method: 'POST', body: json({ policy }) });
export const updateClanPolicy = (token: string, clanId: string, challengeId: string, signature: string) => api<Clan>(`/v1/clans/${encodeURIComponent(clanId)}/policy`, token, { method: 'POST', body: json({ challengeId, signature }) });
export const leaveClan = (token: string, clanId: string) => api<void>(`/v1/clans/${encodeURIComponent(clanId)}/leave`, token, { method: 'POST' });
export const getClanMessages = (token: string, clanId: string, before?: string) => api<ChatPage>(`/v1/clans/${encodeURIComponent(clanId)}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`, token);
export const sendClanMessage = (token: string, clanId: string, body: string, replyTo?: string, markerId?: string) => api<ChatMessage>(`/v1/clans/${encodeURIComponent(clanId)}/messages`, token, { method: 'POST', body: json({ body, ...(replyTo ? { replyTo } : {}), ...(markerId ? { markerId } : {}) }) });
export const getChart = (token: string, clanId: string, marketId?: string) => api<ChartSnapshot>(`/v1/clans/${encodeURIComponent(clanId)}/chart${marketId ? `?marketId=${encodeURIComponent(marketId)}` : ''}`, token);
export const getClanEventUrl = (clanId: string) => {
  if (!BASE) throw new ApiError('Backend API is not configured yet.', 503);
  return `${BASE.replace(/\/$/, '')}/v1/clans/${encodeURIComponent(clanId)}/events`;
};
export const setPositionTpsl = (token: string, marketId: string, values: TpslValues) => api<{ takeProfit: number | null; stopLoss: number | null }>('/v1/positions/tpsl', token, { method: 'POST', body: json({ marketId, ...values }) });
export const suggestMarkerTpsl = (token: string, clanId: string, markerId: string, values: TpslValues) => api<TpslSuggestion>(`/v1/clans/${encodeURIComponent(clanId)}/markers/${encodeURIComponent(markerId)}/suggest-tpsl`, token, { method: 'POST', body: json(values) });
export const getPerplSetup = (token: string) => api<SetupStatus>('/v1/perpl/setup', token);
export const getEnrollmentChallenge = (token: string) => api<EnrollmentChallenge>('/v1/enrollment/perpl/challenge', token, { method: 'POST' });
export const enrollPerpl = (token: string, challengeId: string, signature: string) => api<void>('/v1/enrollment/perpl', token, { method: 'POST', body: json({ challengeId, signature }) });
export const skipAutoMirror = (token: string, clanId: string, markerId: string) => api<void>(`/v1/clans/${encodeURIComponent(clanId)}/mirrors/${encodeURIComponent(markerId)}/skip`, token, { method: 'POST' });
export const stackPosition = (token: string, clanId: string, markerId: string, notionalUsd: number) => api<StackResult>(`/v1/clans/${encodeURIComponent(clanId)}/stack`, token, { method: 'POST', body: json({ markerId, notionalUsd }) });
export const prepareUsdcFunding = (token: string, amountUsdc: string, depositToPerpl: boolean) => api<FundingPlan>('/v1/funding/usdc/prepare', token, { method: 'POST', body: json({ amountUsdc, depositToPerpl }) });
export const confirmUsdcFunding = (token: string, planId: string, hashes: string[]) => api<FundingResult>('/v1/funding/usdc/confirm', token, { method: 'POST', body: json({ planId, hashes }) });
export const createShare = (token: string, markerId: string, includeClan: boolean) => api<ShareResult>('/v1/shares', token, { method: 'POST', body: json({ markerId, includeClan }) });
export const getPublicShare = (id: string) => api<PublicShare>(`/v1/shares/${encodeURIComponent(id)}`, null);
