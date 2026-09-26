// Temporary UI contract until the root CONTRACTS.md is published; see CONTRACT_ASSUMPTIONS.md.
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
  tokenAddress?: `0x${string}`;
};
export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type Clan = { id: string; name: string; inviteCode: string; memberCount: number; myPolicy: MirrorPolicy };
export type Member = {
  id: string;
  name: string;
  address: `0x${string}`;
  winRate: number | null;
  realizedPnlUsd: number | null;
  tradeCount: number;
  verified: boolean;
};
export type ChartMarker = {
  id: string;
  memberId: string;
  memberName: string;
  marketId: string;
  venue: Venue;
  origin: MarkerOrigin;
  side: TradeSide;
  entryTime: number;
  entryPrice: number;
  markPrice: number;
  pnlUsd: number;
  valueUsd: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  tokenAmount?: string;
  isMine: boolean;
  mirrorStatus?: 'pending' | 'submitted' | 'filled';
  skipUntil?: string;
};
export type ChartSnapshot = {
  clan: Clan;
  markets: Market[];
  selectedMarket: Market;
  candles: Candle[];
  markers: ChartMarker[];
  members: Member[];
  asOf: string;
  autoMirrorOptOutWindowSeconds: number | null;
};
export type Me = { address: `0x${string}`; name: string; clans: Clan[]; usdcBalance: string | null };
export type WalletAction = { to: `0x${string}`; data: `0x${string}`; value?: `0x${string}`; chainId: number };
export type SignedChallenge = { message: string; challengeId: string };
export type FundingPlan = { requiredUsdc: string; actions: WalletAction[] };
export type StackQuote = { id: string; venue: Venue; marketId: string; sizeUsd: number; action: WalletAction; expiresAt: string };
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
  clanName?: string;
};

