// One trade abstraction over both venues. Everything above this layer (the
// mirror engine, manual stacks, the API) talks to a VenueAdapter and never to
// Perpl or Nad.fun directly. Amounts that cross this boundary are in AUSD;
// raw on-chain sizes travel as decimal strings so nothing loses precision.

export type Venue = 'perpl' | 'nadfun';
export type TradeSide = 'long' | 'short' | 'buy';

// How an order can be recognised later. Fired before the order leaves, so the
// engine can tag it before the venue reports it back.
export interface OrderRef {
  rq?: number; // perpl request id
  accountId?: number; // perpl account
  txHash?: string; // nadfun tx
  wallet?: string;
}

export interface OpenInput {
  userId: string;
  market: string; // perpl market id, or nadfun token address
  side: TradeSide; // nadfun: 'buy'
  notionalAusd: number; // perpl: position notional; nadfun: MON spent, valued in AUSD
  leverage?: number; // perpl only
  onRef?: (ref: OrderRef) => void;
}

export interface CloseInput {
  userId: string;
  market: string;
  sizeRaw?: string; // close only this much (a mirror's own slice); default all
  onRef?: (ref: OrderRef) => void;
}

export interface Fill {
  venue: Venue;
  market: string;
  side: TradeSide;
  sizeRaw: string;
  size: number;
  priceAusd: number;
  notionalAusd: number;
  orderId?: number;
  requestId?: number;
  txHash?: string | null;
  extraTxs?: string[]; // approvals / swaps that were part of this trade
}

export interface Holding {
  venue: Venue;
  market: string;
  symbol: string;
  side: TradeSide;
  sizeRaw: string;
  size: number;
  entryPriceAusd: number | null;
  markPriceAusd: number;
  valueAusd: number;
  pnlAusd: number | null;
  leverage: number;
}

export interface VenueAdapter {
  readonly venue: Venue;
  open(i: OpenInput): Promise<Fill>;
  close(i: CloseInput): Promise<Fill>;
  holdings(userId: string, markets?: string[]): Promise<Holding[]>;
  freeBalanceAusd(userId: string): Promise<number>;
  markPriceAusd(market: string): Promise<number>;
  maxLeverage(market: string): Promise<number>;
}

export const venueOf = (market: string): Venue => (/^0x[0-9a-fA-F]{40}$/.test(market) ? 'nadfun' : 'perpl');
