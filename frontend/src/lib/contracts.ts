// Perpl fields follow CONTRACTS.md at backend commit 8c0c1c1. Nad.fun and shares remain provisional.
export type Venue = 'perpl' | 'nadfun';
export type MarkerOrigin = 'leader' | 'auto_mirror' | 'manual_stack';
export type TradeSide = 'long' | 'short' | 'buy';
export type MirrorPolicy = {
  enabled: boolean;
  balancePercentCap: number;
  maxUsdPerTrade: number;
};
export type Market = {
  venue: Venue;
  id: string;
  symbol: string;
  baseSymbol: string;
  quoteSymbol: string;
  maxLeverage?: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
  tokenAddress?: `0x${string}`;
};
export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type Clan = { id: string; name: string; inviteCode: string; memberCount: number; myPolicy: MirrorPolicy | null };
export type Member = {
  id: string;
  name: string;
  address: string;
  winRate: number | null;
  realizedPnlUsd: number | null;
  tradeCount: number;
  verified: boolean;
};
export type ChartMarker = {
  id: string;
  tradeId: string;
  memberId: string;
  memberName: string;
  marketId: string;
  venue: Venue;
  origin: MarkerOrigin;
  side: TradeSide;
  entryTime: number;
  entryPrice: number | null;
  markPrice: number;
  size: number | null;
  pnlUsd: number | null;
  valueUsd: number | null;
  leverage: number | null;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
  tokenAmount?: string;
  isMine: boolean;
  mirrorStatus?: 'pending' | 'submitted' | 'filled';
  skipUntil?: string;
  txHash?: string | null;
};
export type ChartSnapshot = {
  clan: Clan;
  markets: Market[];
  selectedMarket: Market;
  candles: Candle[];
  markers: ChartMarker[];
  members: Member[];
  asOf: string;
  autoMirrorOptOutWindowSeconds: number;
};
export type BackendConfig = {
  chainId: number;
  venue: string;
  autoMirrorOptOutWindowSeconds: number;
  mirrorPolicyBounds: unknown;
  markets: Market[];
};
export type Me = {
  id: string;
  address: `0x${string}`;
  name: string;
  clans: Clan[];
  perpl: { accountId: string | null; keyEnrolled: boolean; forwarding: boolean };
  usdcBalance: string | null;
};
export type WalletAction = { to: string; data: string; value?: string; chainId: number; label: string };
export type SetupStatus = {
  step: 'needs_collateral' | 'needs_account' | 'needs_key' | 'needs_forwarding' | 'ready';
  wallet: string;
  perplAccountId: string | null;
  collateralBalance: string;
  minAccountOpen: string;
  actions: WalletAction[];
};
export type SignedChallenge = { message: string; challengeId: string };
export type EnrollmentChallenge = { challengeId: string; typedData: Record<string, unknown>; expiresAt: string };
export type StackResult = {
  id: string;
  status: 'open' | 'failed';
  marketId: string;
  side: 'long' | 'short';
  size: number;
  notionalUsd: number;
  leverage: number;
  orderId?: string;
  txHash?: string;
  error?: string;
};
// Public sharing is not yet defined by the backend/indexer contract.
export type ShareResult = { id: string; url: string; imageUrl?: string };
export type PublicShare = {
  id: string;
  traderName: string;
  marketSymbol: string;
  venue: Venue;
  pnlUsd: number;
  roiPercent: number | null;
  notionalUsd: number | null;
  closedAt: string | null;
  includeClan: boolean;
  clanName?: string;
};
