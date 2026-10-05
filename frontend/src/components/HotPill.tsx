import { Flame } from './icons';

// A butter "Hot" pill: a market up 10% or more today, or one of the busiest cults.
export const HOT_CHANGE_PCT = 10;
export const isHotMarket = (change24hPct: number | null | undefined) => (change24hPct ?? 0) >= HOT_CHANGE_PCT;
export const HotPill = () => <span className="hot-pill" title="Trending"><Flame size={11} strokeWidth={2} aria-hidden="true" /><span className="hot-pill-label">Hot</span></span>;
