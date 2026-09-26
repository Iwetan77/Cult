import type { ChartSnapshot, Clan, FundingPlan, Me, MirrorPolicy, ShareResult, SignedChallenge, StackQuote, Venue } from './contracts';

const BASE = process.env.NEXT_PUBLIC_CULT_API_BASE_URL;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
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
    throw new ApiError(body.message ?? `Request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (value: unknown) => JSON.stringify(value);
export const getMe = (token: string) => api<Me>('/v1/me', token);
export const createClan = (token: string, name: string) => api<Clan>('/v1/clans', token, { method: 'POST', body: json({ name }) });
export const getJoinChallenge = (token: string, inviteCode: string) => api<SignedChallenge>('/v1/clans/join/challenge', token, { method: 'POST', body: json({ inviteCode }) });
export const joinClan = (token: string, inviteCode: string, policy: MirrorPolicy, challengeId: string, signature: string) => api<Clan>('/v1/clans/join', token, { method: 'POST', body: json({ inviteCode, policy, challengeId, signature }) });
export const getChart = (token: string, clanId: string, marketId?: string) => api<ChartSnapshot>(`/v1/clans/${encodeURIComponent(clanId)}/chart${marketId ? `?marketId=${encodeURIComponent(marketId)}` : ''}`, token);
export const prepareFunding = (token: string, clanId: string, amountUsdc: string) => api<FundingPlan>(`/v1/clans/${encodeURIComponent(clanId)}/funding/prepare`, token, { method: 'POST', body: json({ amountUsdc }) });
export const confirmFunding = (token: string, clanId: string, planId: string, hashes: string[]) => api<void>(`/v1/clans/${encodeURIComponent(clanId)}/funding/confirm`, token, { method: 'POST', body: json({ planId, hashes }) });
export const getEnrollmentChallenge = (token: string, venue: Venue) => api<SignedChallenge>(`/v1/enrollment/${venue}/challenge`, token, { method: 'POST' });
export const enrollVenue = (token: string, venue: Venue, challengeId: string, signature: string) => api<void>(`/v1/enrollment/${venue}`, token, { method: 'POST', body: json({ challengeId, signature }) });
export const quoteStack = (token: string, clanId: string, markerId: string, sizeUsd: number) => api<StackQuote>(`/v1/clans/${encodeURIComponent(clanId)}/stack/quote`, token, { method: 'POST', body: json({ markerId, sizeUsd }) });
export const confirmStack = (token: string, clanId: string, quoteId: string, txHash: string) => api<void>(`/v1/clans/${encodeURIComponent(clanId)}/stack/confirm`, token, { method: 'POST', body: json({ quoteId, txHash }) });
export const createShare = (token: string, markerId: string, includeClan: boolean) => api<ShareResult>('/v1/shares', token, { method: 'POST', body: json({ markerId, includeClan }) });
export const getPublicShare = (id: string) => api<import('./contracts').PublicShare>(`/v1/shares/${encodeURIComponent(id)}`, null);

export const skipAutoMirror = (token: string, clanId: string, markerId: string) => api<void>(`/v1/clans/${encodeURIComponent(clanId)}/mirrors/${encodeURIComponent(markerId)}/skip`, token, { method: 'POST' });

