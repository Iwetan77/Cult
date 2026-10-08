export type Venue = 'perpl' | 'nadfun';
export type MarkerOrigin = 'leader' | 'auto_mirror' | 'manual_stack';
export type TradeSide = 'long' | 'short' | 'buy';
export type MirrorPolicy = {
  enabled: boolean;
  balancePercentCap: number; // (0, 100] of free venue balance: perp margin or meme spend.
  maxUsdPerTrade: number; // [1, 1e6] dollar notional per copy/add, including perp leverage; not fixed spend.
};
export type Market = {
  venue: Venue; id: string; symbol: string; baseSymbol: string; quoteSymbol: 'USD';
  maxLeverage: number; makerFeeBps: number | null; takerFeeBps: number | null;
  tokenAddress?: string; imageUri?: string;
};
export type NadMarket = Market & { name: string; graduated: boolean; priceAusd: number };
export type Candle = { time: number; open: number; high: number; low: number; close: number };
// isAdmin: admins share their trades with the cult (the creator always is one).
export type Clan = { id: string; name: string; inviteCode: string; visibility: 'private' | 'public'; isOwner: boolean; isAdmin?: boolean; memberCount: number; myPolicy: MirrorPolicy | null; autoFollow: boolean; imageUrl?: string | null };
export type Member = {
  id: string; name: string; avatarUrl: string | null; address: string; admin?: boolean; winRate: number | null;
  realizedPnlUsd: number | null; tradeCount: number; verified: boolean;
  stats: {
    verified: boolean; tradeCount: number; winRate: number | null;
    realizedPnlPerplUsd: number; realizedPnlMon: number; realizedPnlUsd: number | null;
    monPriceUsed: number | null; lastTradeAt: number | null; streak: number; avgWinPct: number | null;
    copied: { tradeCount: number; winRate: number | null; realizedPnlUsd: number | null };
  };
};
export type ChatRoom = { id: string; kind: 'global' | 'country' | 'cult'; name: string; icon: string; memberCount: number; lastMessage: ChatMessage | null };
export type DiscoverCult = { id: string; name: string; visibility: 'public'; memberCount: number; createdAt: string; joined: boolean; imageUrl?: string | null };
export type BoardPeriod = 'all' | '30d' | '7d';
export type LeaderboardEntry = { rank: number; memberId: string; name: string; avatarUrl: string | null; address: string; country: string | null; realizedPnlUsd: number; winRate: number | null; tradeCount: number; copiedTradeCount: number };
export type Leaderboard = { scope: string; name: string; metric: 'realizedPnlUsd'; period: BoardPeriod; entries: LeaderboardEntry[]; me: (Omit<LeaderboardEntry, 'rank'> & { rank: number | null }) | null; rankedCount: number; memberCount: number; asOf: string };
export type CultStanding = { rank: number; cultId: string; name: string; memberCount: number; realizedPnlUsd: number; winRate: number | null; tradeCount: number; joined: boolean };
export type ChatMessage = {
  id: string; room: string; kind: 'text' | 'system'; clanId: string | null; memberId: string; memberName: string;
  memberAvatarUrl: string | null; body: string; text: string;
  replyTo: string | null; markerId: string | null; createdAt: string;
  reactions?: Reaction[];
  imageUrl?: string | null; // a photo sent with the message (the body is its caption, or empty)
};
// An emoji reaction on a message: how many, and whether one is yours.
export type Reaction = { emoji: string; count: number; mine: boolean };
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
  // What the backend has switched on (older backends omit it: treat as off).
  features?: { predictions: boolean; crossChain: boolean; gasTopUp?: boolean };
};
export type Me = {
  id: string; address: `0x${string}`; name: string; username: string | null; needsUsername: boolean; pinSet?: boolean;
  usernameChangedAt?: string | null; // last time the member changed their username (not the first pick); once every 3 months
  avatarUrl: string | null; country: { code: string; name: string } | null; rooms: ChatRoom[]; clans: Clan[];
  perpl: { accountId: string | null; keyEnrolled: boolean; forwarding: boolean };
  balances: {
    perplMarginUsd: number | null; walletUsd: number; mon: number; monUsd: number | null;
    predictionsUsd?: number | null; // in the member's Polymarket account (counted in the one balance)
    usdcUsd?: number | null; // USDC in the wallet (mainnet): dollars too, turned into AUSD by itself
    gasReserveMon: number; lowGas: boolean; memesPayWith: 'ausd' | 'mon';
  } | null;
  signer: { prepared: boolean; attached: boolean | null; policyCurrent: boolean | null };
  usdcConverted: { usdc: number; ausd: number; tx: string; at: number } | null;
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
  id: string; traderName: string; traderAvatarUrl?: string | null; marketSymbol: string; venue: Venue; side: TradeSide; leverage?: number | null;
  pnlUsd: number | null; roiPercent: number | null; notionalUsd: number | null;
  entryPrice: number | null; markPrice: number | null; closedAt: string | null;
  sharedAt: string; includeClan: boolean; clanName?: string;
  traderRecord?: { verified: boolean; tradeCount: number; winRate: number | null; realizedPnlUsd: number | null; streak: number };
};
export type Home = {
  topTrades: { rank: number; memberId: string; name: string; avatarUrl: string | null; venue: string; market: string; symbol: string; side: string;
    returnPct: number; pnlUsd: number | null; closedAt: number; tradersIn: number; markerId: string | null;
    tradeId: string | null; cultId: string | null; openTx: string }[];
  sevenDay: { trades: number; profitUsd: number; positionsOpened: number };
  asOf: string;
};
export type ClosedTrade = { venue: Venue; market: string; symbol: string; side: string; returnPct: number | null;
  pnlUsd: number | null; entryPrice: number | null; exitPrice: number | null; isWin: boolean;
  openedAt: number | null; closedAt: number; openTx: string; tradeId: string | null; copied: boolean };
export type TradeView = {
  tradeId: string; markerId: string; member: { id: string; name: string; avatarUrl: string | null; address: string };
  venue: Venue; market: string; symbol: string; side: string; leverage: number;
  openedAt: number; openTx: string | null; status: 'open' | 'closed'; closedAt: number | null;
  result: { returnPct: number | null; pnlUsd: number | null; entryPrice: number | null; exitPrice: number | null; isWin: boolean } | null;
  tradersIn: number; youCopied: boolean; cultId: string | null;
};
export type Profile = { id: string; name: string; username: string | null; avatarUrl: string | null; address: string; country: { code: string; name: string | null } | null;
  memberSince: number; isMe: boolean; record: Member['stats'];
  openTrades: { tradeId: string; markerId: string; venue: string; market: string; symbol: string; side: string; leverage: number; openedAt: number }[];
  closedTrades: ClosedTrade[]; cults: { id: string; name: string; visibility: string; imageUrl?: string | null }[] };

export type MarketListing = { venue: Venue; id: string; symbol: string; name: string; priceUsd: number | null; change24hPct: number | null; volume24hUsd: number | null; imageUri: string | null; maxLeverage: number };
export type MarketDetail = { market: MarketListing; candles: Candle[]; resolution: number };
export type DepositInfo = { address: string; network: { name: string; chainId: number }; tokens: { symbol: 'MON' | 'USDC' | 'AUSD'; name: string; what: string; balance: number | null; balanceUsd: number | null; depositSupported?: boolean }[]; tradingAccountUsd: number | null; totalUsd: number | null };
// Prediction markets (Polymarket). Demo-only trading for now.
export type PredictionSide = 'yes' | 'no';
export type PredictionPosition = {
  id: string; marketId: string; eventSlug: string; eventTitle: string; outcomeLabel: string; question: string; image: string | null;
  side: PredictionSide; sideLabel: string; shares: number; avgPrice: number; costUsd: number; openedAt: number;
};
export type PredictionOrder = {
  marketId: string; eventSlug: string; eventTitle: string; outcomeLabel: string; question: string; image: string | null;
  side: PredictionSide; sideLabel: string; price: number; amountUsd: number; cultIds?: string[];
};
export type PredictionSale = { position: PredictionPosition; price: number; proceedsUsd: number; pnlUsd: number };
export type PredictionClosed = PredictionSale & { closedAt: number };
export type PredictionBet = {
  memberId: string; memberName: string; avatarUrl: string | null; cultName: string;
  marketId: string; outcomeLabel: string; side: PredictionSide; sideLabel: string; shares: number; avgPrice: number;
};
export type WithdrawRequest = { symbol: DepositInfo['tokens'][number]['symbol']; amount: number; to: string; pin?: string };
export type WithdrawResult = WithdrawRequest & { tx: string };

// Steps only the member's own wallet may sign (opening the Polymarket account,
// a bet without a session key, moving money out) come back as a FlowStep:
// sign `signature`, POST it, repeat until `done`. See CONTRACTS.md.
export type SignatureRequest = {
  challengeId: string; label: string; kind: 'typedData' | 'message';
  typedData: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> } | null;
  message: `0x${string}` | null; expiresAt: string;
};
export type FlowStep<T> =
  | { status: 'needs_signature'; flowId: string; signature: SignatureRequest }
  | { status: 'working'; flowId: string; label: string }
  | { status: 'done'; flowId: string; result: T };
export type GeoAccess = 'open' | 'close_only' | 'blocked';
export type PredictionAccount = {
  enabled: boolean; step: 'unavailable' | 'needs_setup' | 'needs_funds' | 'ready'; reason: string | null;
  wallet: string | null; balanceUsd: number | null; signsEachBet: boolean;
  funding: { from: 'AUSD'; minUsd: number; network: string } | null;
  access?: { country: string | null; predictions: GeoAccess; perps: GeoAccess };
};
// amountUsd lands; sendUsd leaves the wallet (amountUsd plus the bridge's fee, feeUsd).
export type PredictionFundPlan = { actions: WalletAction[]; depositAddress: string; amountUsd: number; sendUsd: number; feeUsd: number | null; receiveUsd: number | null; seconds: number | null };
export type PredictionRedeem = { positionId: string; payoutUsd: number; tx: string | null };
// A Monad send the member's wallet signs (the backend can't move funds).
export type WithdrawPrepared = WithdrawRequest & { actions: WalletAction[] };
// Cross-chain (Aurora Intents).
export type IntentChain = { chain: string; name: string; evm: boolean; tokens: { assetId: string; symbol: string; decimals: number; priceUsd: number | null }[] };
export type IntentSwapStatus = 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED';
export type IntentSwap = {
  depositAddress: string; depositMemo: string | null; kind: 'deposit' | 'withdraw'; chain: string; chainName: string; symbol: string;
  amountIn: string; amountInUsd: number | null; receive: string; receiveSymbol: string; receiveUsd: number | null; minReceive: string;
  seconds: number; deadline: string; status: IntentSwapStatus;
};
export type IntentWithdraw = IntentSwap & { actions: WalletAction[] };
export type IntentStatus = { status: IntentSwapStatus; done: boolean; received: string | null; receivedUsd: number | null; refunded: string | null; refundReason: string | null; txs: { hash: string; url: string | null }[] };
