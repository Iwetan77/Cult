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
export type Clan = { id: string; name: string; inviteCode: string; visibility: 'private' | 'public'; isOwner: boolean; memberCount: number; myPolicy: MirrorPolicy | null; autoFollow: boolean };
export type Member = {
  id: string; name: string; address: string; winRate: number | null;
  realizedPnlUsd: number | null; tradeCount: number; verified: boolean;
  stats: {
    verified: boolean; tradeCount: number; winRate: number | null;
    realizedPnlPerplUsd: number; realizedPnlMon: number; realizedPnlUsd: number | null;
    monPriceUsed: number | null; lastTradeAt: number | null; streak: number; avgWinPct: number | null;
    copied: { tradeCount: number; winRate: number | null; realizedPnlUsd: number | null };
  };
};
export type ChatRoom = { id: string; kind: 'global' | 'country' | 'cult'; name: string; memberCount: number; lastMessage: ChatMessage | null };
export type DiscoverCult = { id: string; name: string; visibility: 'public'; memberCount: number; createdAt: string; joined: boolean };
export type LeaderboardEntry = { rank: number; memberId: string; name: string; address: string; country: string | null; realizedPnlUsd: number; winRate: number | null; tradeCount: number; copiedTradeCount: number };
export type Leaderboard = { scope: string; name: string; metric: 'realizedPnlUsd'; period: 'all'; entries: LeaderboardEntry[]; me: (Omit<LeaderboardEntry, 'rank'> & { rank: number | null }) | null; rankedCount: number; memberCount: number; asOf: string };
export type CultStanding = { rank: number; cultId: string; name: string; memberCount: number; realizedPnlUsd: number; winRate: number | null; tradeCount: number; joined: boolean };
export type ChatMessage = {
  id: string; room: string; kind: 'text' | 'system'; clanId: string | null; memberId: string; memberName: string; body: string;
  replyTo: string | null; markerId: string | null; createdAt: string;
};
export type ChatPage = { messages: ChatMessage[]; hasMore: boolean; pinned: { id: string; memberName: string; body: string } | null };
export type TpslSuggestion = {
  id: string; markerId: string; tradeId: string; fromMemberId: string; fromName: string;
  takeProfitPrice: number | null; stopLossPrice: number | null; createdAt: string;
};
export type TpslValues = { takeProfit?: number | null; stopLoss?: number | null };
export type ChartMarker = {
  id: string; tradeId: string; memberId: string; memberName: string; marketId: string;
  venue: Venue; origin: MarkerOrigin; side: TradeSide; entryTime: number;
  entryPrice: number | null; markPrice: number; size: number | null;
  pnlUsd: number | null; valueUsd: number | null; leverage: number | null;
  takeProfitPrice?: number | null; stopLossPrice?: number | null; suggestions?: TpslSuggestion[];
  isMine: boolean; mirrorStatus?: 'pending' | 'submitted' | 'filled';
  skipUntil?: string; pendingAdd?: { id: string; ratio: number; skipUntil: string } | null;
  txHash?: string | null;
};
export type ChartSnapshot = {
  clan: Clan; markets: Market[]; selectedMarket: Market; candles: Candle[];
  markers: ChartMarker[]; members: Member[]; asOf: string;
  autoMirrorOptOutWindowSeconds: number;
};
export type BackendConfig = {
  chainId: number; venues: Venue[]; displayUnit: 'USD'; monPriceAusd: number | null;
  autoMirrorOptOutWindowSeconds: number; autoFollowDefaults: { balancePercentCap: number; maxUsdPerTrade: number }; mirrorPolicyBounds: unknown; markets: Market[];
};
export type Me = {
  id: string; address: `0x${string}`; name: string; country: { code: string; name: string } | null; rooms: ChatRoom[]; clans: Clan[];
  perpl: { accountId: string | null; keyEnrolled: boolean; forwarding: boolean };
  balances: {
    perplMarginUsd: number | null; walletUsd: number; mon: number; monUsd: number | null;
    gasReserveMon: number; lowGas: boolean; memesPayWith: 'ausd' | 'mon';
  } | null;
  signer: { prepared: boolean; attached: boolean | null; policyCurrent: boolean | null };
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
  id: string; expiresAt: string; requiredUsdc: string; minAusdOut: string; expectedAusdOut: string; depositToPerpl: boolean; actions: WalletAction[];
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
export type Home = {
  topTrades: { rank: number; memberId: string; name: string; venue: string; market: string; symbol: string; side: string;
    returnPct: number; pnlUsd: number | null; closedAt: number; tradersIn: number; markerId: string | null;
    tradeId: string | null; cultId: string | null; openTx: string }[];
  sevenDay: { trades: number; profitUsd: number; positionsOpened: number };
  asOf: string;
};
export type ClosedTrade = { venue: Venue; market: string; symbol: string; side: string; returnPct: number | null;
  pnlUsd: number | null; entryPrice: number | null; exitPrice: number | null; isWin: boolean;
  openedAt: number | null; closedAt: number; openTx: string; tradeId: string | null; copied: boolean };
export type TradeView = {
  tradeId: string; markerId: string; member: { id: string; name: string; address: string };
  venue: Venue; market: string; symbol: string; side: string; leverage: number;
  openedAt: number; openTx: string | null; status: 'open' | 'closed'; closedAt: number | null;
  result: { returnPct: number | null; pnlUsd: number | null; entryPrice: number | null; exitPrice: number | null; isWin: boolean } | null;
  tradersIn: number; youCopied: boolean; cultId: string | null;
};
export type Profile = { id: string; name: string; address: string; country: { code: string; name: string | null } | null;
  memberSince: number; isMe: boolean; record: Member['stats'];
  openTrades: { tradeId: string; markerId: string; venue: string; market: string; symbol: string; side: string; leverage: number; openedAt: number }[];
  closedTrades: ClosedTrade[]; cults: { id: string; name: string; visibility: string }[] };
