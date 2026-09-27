export type Venue = 'perpl' | 'nadfun';
export type MarkerOrigin = 'leader' | 'auto_mirror' | 'manual_stack';
export type TradeSide = 'long' | 'short' | 'buy';
export type MirrorPolicy = { enabled: boolean; balancePercentCap: number; maxUsdPerTrade: number };
export type Market = {
  venue: Venue; id: string; symbol: string; baseSymbol: string; quoteSymbol: 'USD';
  maxLeverage: number; makerFeeBps: number | null; takerFeeBps: number | null;
  tokenAddress?: string; imageUri?: string;
};
export type NadMarket = Market & { name: string; graduated: boolean; priceAusd: number };
export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type Clan = { id: string; name: string; inviteCode: string; memberCount: number; myPolicy: MirrorPolicy | null };
export type Member = {
  id: string; name: string; address: string; winRate: number | null;
  realizedPnlUsd: number | null; tradeCount: number; verified: boolean;
};
export type ChartMarker = {
  id: string; tradeId: string; memberId: string; memberName: string; marketId: string;
  venue: Venue; origin: MarkerOrigin; side: TradeSide; entryTime: number;
  entryPrice: number | null; markPrice: number; size: number | null;
  pnlUsd: number | null; valueUsd: number | null; leverage: number | null;
  isMine: boolean; mirrorStatus?: 'pending' | 'submitted' | 'filled';
  skipUntil?: string; txHash?: string | null;
};
export type ChartSnapshot = {
  clan: Clan; markets: Market[]; selectedMarket: Market; candles: Candle[];
  markers: ChartMarker[]; members: Member[]; asOf: string;
  autoMirrorOptOutWindowSeconds: number;
};
export type BackendConfig = {
  chainId: number; venues: Venue[]; displayUnit: 'USD'; monPriceAusd: number | null;
  autoMirrorOptOutWindowSeconds: number; mirrorPolicyBounds: unknown; markets: Market[];
};
export type Me = {
  id: string; address: `0x${string}`; name: string; clans: Clan[];
  perpl: { accountId: string | null; keyEnrolled: boolean; forwarding: boolean };
  usdcBalance: string | null;
};
export type PrivySignerGrant = {
  signerId: string; policyIds: string[]; capAusd: number; maxBuyMon: number; monPriceAusd: number;
};
export type WalletAction = { to: string; data: string; value?: string; chainId: number; label: string };
export type SetupStatus = {
  step: 'needs_collateral' | 'needs_account' | 'needs_key' | 'needs_forwarding' | 'ready';
  wallet: string; perplAccountId: string | null; collateralBalance: string;
  minAccountOpen: string; actions: WalletAction[];
};
export type SignedChallenge = { message: string; challengeId: string };
export type EnrollmentChallenge = { challengeId: string; typedData: Record<string, unknown>; expiresAt: string };
export type StackResult = {
  id: string; venue: Venue; status: 'open' | 'failed'; market: string; side: TradeSide;
  size: number; notionalAusd: number; leverage: number;
  orderId?: string; txHash?: string; error?: string;
};
export type Holding = {
  venue: Venue; market: string; symbol: string; side: TradeSide;
  sizeRaw: string; size: number; entryPriceAusd: number | null;
  markPriceAusd: number; valueAusd: number; pnlAusd: number | null; leverage: number;
};
export type Fill = {
  venue: Venue; market: string; side: TradeSide; sizeRaw: string; size: number;
  priceAusd: number; notionalAusd: number; orderId?: number;
  requestId?: number; txHash?: string | null;
};
export type FundingPlan = {
  id: string; expiresAt: string; requiredUsdc: string; minAusdOut: string; actions: WalletAction[];
};
export type FundingResult = {
  planId: string; done: boolean; steps: { label: string; txHash: string; ok: boolean }[];
  perplAccountId: string | null;
};
export type ShareResult = { id: string; url: string };
export type PublicShare = {
  id: string; traderName: string; marketSymbol: string; venue: Venue; side: TradeSide;
  pnlUsd: number | null; roiPercent: number | null; notionalUsd: number | null;
  entryPrice: number | null; markPrice: number | null; closedAt: string | null;
  sharedAt: string; includeClan: boolean; clanName?: string;
};