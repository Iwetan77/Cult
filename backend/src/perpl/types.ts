// Wire types for the Perpl API. Field names are Perpl's own (short keys); see
// PerplFoundation/api-docs types.md. Only what this service reads is modelled.

export interface BlockTimestamp {
  b?: number;
  t?: number;
}

export interface BlockTxTimestamp extends BlockTimestamp {
  tx?: number;
  txid?: string;
}

export interface MarketConfig {
  is_open: boolean;
  price_decimals: number;
  size_decimals: number;
  initial_margin: number; // hundredths of a percent: 1500 = 15% = 6.67x max
  maintenance_margin: number;
  maker_fee: number; // micros
  taker_fee: number; // micros
  maker_fees?: number[];
  taker_fees?: number[];
}

export interface MarketState {
  at: BlockTimestamp;
  orl: number;
  mrk: number;
  lst: number;
  mid: number;
  bid: number;
  ask: number;
}

export interface FundingEvent {
  at: BlockTimestamp;
  rate: number; // micros
}

export interface Market {
  id: number;
  symbol: string;
  name: string;
  order_ttl_blocks: number;
  order_max_market_slippage_bps: number;
  funding_interval_sec: number;
  funding_interval_blocks: number;
  config: MarketConfig;
  state?: MarketState;
  funding?: FundingEvent;
}

export interface Token {
  id: number;
  address: string;
  symbol: string;
  decimals: number;
}

export interface Instance {
  id: number;
  address: string;
  collateral_token_id: number;
  min_account_open_amount: string;
  min_deposit_amount: string;
}

export interface Context {
  chain: { chain_id: number };
  instances: Instance[];
  tokens: Token[];
  markets: Market[];
}

export enum OrderType {
  OpenLong = 1,
  OpenShort = 2,
  CloseLong = 3,
  CloseShort = 4,
  Cancel = 5,
  IncreasePositionCollateral = 6,
  Change = 7,
}

export enum OrderFlags {
  GoodTillCancel = 0,
  PostOnly = 1,
  FillOrKill = 2,
  ImmediateOrCancel = 4,
}

export enum OrderStatus {
  Unspecified = 0,
  Pending = 1,
  Open = 2,
  PartiallyFilled = 3,
  Filled = 4,
  Canceled = 5,
  Expired = 6,
  Failed = 7,
  Untriggered = 8,
  Triggered = 9,
  Executed = 10,
}

export enum PositionSide {
  Long = 1,
  Short = 2,
}

export enum PositionStatus {
  Open = 1,
  Closed = 2,
  Liquidated = 3,
  Deleveraged = 4,
  Unwound = 5,
  Failed = 6,
}

// The client-described order. Same shape over WS (under mt:22) and REST batch.
export interface OrderSpec {
  rq: number;
  mkt: number;
  acc: number;
  oid?: number;
  t: OrderType;
  p?: number;
  s?: number;
  ms?: number;
  mnp?: number;
  fl: OrderFlags;
  lv: number; // hundredths: 500 = 5x
  lb: number;
  lp?: number;
}

export interface Order {
  at: BlockTxTimestamp;
  c: BlockTxTimestamp;
  rq: number;
  mkt: number;
  acc: number;
  oid: number;
  st: OrderStatus;
  sr: number;
  fr?: number;
  t: OrderType;
  r?: boolean;
  p?: number;
  os: number;
  fp: number;
  fs: number;
  f: string;
  lv: number;
}

export interface Position {
  at: BlockTxTimestamp;
  mkt: number;
  acc: number;
  pid: number;
  rq: number;
  oid: number;
  st: PositionStatus;
  sr: number;
  sd: PositionSide;
  c: string; // collateral, raw collateral units
  ep: number; // entry price, scaled
  s: number; // size, scaled
  fee: string;
  cfee?: string;
  efs: number;
  lv: number;
  dpnl?: string;
  fnd?: string;
  xp?: number;
  ots: BlockTxTimestamp;
  e?: Position[];
}

export interface Fill {
  at: BlockTxTimestamp;
  mkt: number;
  acc: number;
  oid: number;
  t: OrderType;
  l: number;
  p?: number;
  s: number;
  f: string;
}

export interface Account {
  in: number;
  id: number;
  fr: boolean;
  fw: boolean; // order forwarding ("one-click trading") enabled
  ft: number;
  lfr: number; // last forwarded request id
  b: string; // balance, raw collateral units
  lb: string; // locked balance
}

export interface Wallet {
  mt: 19;
  sn: number;
  at: BlockTimestamp;
  addr: string;
  as?: Account[];
}

export interface Snapshot<T> {
  sn: number;
  at: BlockTimestamp;
  d: T[];
}

export interface HistoryPage<T> {
  d: T[];
  np: string;
}

export interface Status {
  code: number;
  error?: string;
}
