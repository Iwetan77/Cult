'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { ArrowRight, X } from 'lucide-react';
import { getTrade } from '@/lib/api';
import type { ClosedTrade, Home, TradeView, Venue } from '@/lib/contracts';
import { dollars, percent, shortAddress, signedDollars } from '@/lib/format';

export type TradeSheetTarget =
  | { kind: 'trade'; tradeId: string }
  | { kind: 'home'; trade: Home['topTrades'][number] }
  | { kind: 'closed'; trade: ClosedTrade; member: { id: string; name: string; address: string } };

type Summary = {
  member: { id: string; name: string; address: string | null };
  venue: Venue; market: string; symbol: string; side: string; leverage: number | null;
  openedAt: number | null; closedAt: number | null; status: 'open' | 'closed';
  result: Pick<NonNullable<TradeView['result']>, 'returnPct' | 'pnlUsd' | 'entryPrice' | 'exitPrice'> | null;
  tradersIn: number | null; youCopied: boolean;
  cultId: string | null; markerId: string | null;
};

type Props = {
  target: TradeSheetTarget;
  onClose: () => void;
  onProfile: (id: string) => void;
  onChart: (cultId: string, markerId: string, market: string) => void;
};

function fallbackSummary(target: Exclude<TradeSheetTarget, { kind: 'trade' }>): Summary {
  if (target.kind === 'home') {
    const trade = target.trade;
    return {
      member: { id: trade.memberId, name: trade.name, address: null },
      venue: trade.venue as Venue, market: trade.market, symbol: trade.symbol, side: trade.side,
      leverage: null, openedAt: null, closedAt: trade.closedAt, status: 'closed',
      result: { returnPct: trade.returnPct, pnlUsd: trade.pnlUsd, entryPrice: null, exitPrice: null },
      tradersIn: trade.tradersIn, youCopied: false, cultId: trade.cultId, markerId: trade.markerId,
    };
  }
  const trade = target.trade;
  return {
    member: target.member, venue: trade.venue, market: trade.market, symbol: trade.symbol, side: trade.side,
    leverage: null, openedAt: trade.openedAt, closedAt: trade.closedAt, status: 'closed',
    result: trade.returnPct == null && trade.pnlUsd == null ? null : {
      returnPct: trade.returnPct, pnlUsd: trade.pnlUsd, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
    },
    tradersIn: null, youCopied: trade.copied, cultId: null, markerId: null,
  };
}

const dateTime = (value: number | null) => value == null ? '—' : new Date(value).toLocaleString();

export function TradeSheet({ target, onClose, onProfile, onChart }: Props) {
  const [trade, setTrade] = useState<TradeView | null>(null);
  const [loading, setLoading] = useState(target.kind === 'trade');
  const [error, setError] = useState<string | null>(null);
  const tradeId = target.kind === 'trade' ? target.tradeId : null;

  useEffect(() => {
    if (!tradeId) return;
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to view this trade.');
      return getTrade(token, tradeId);
    }).then(value => { if (active) setTrade(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Trade unavailable.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tradeId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const summary: Summary | null = trade ? {
    member: trade.member, venue: trade.venue, market: trade.market, symbol: trade.symbol,
    side: trade.side, leverage: trade.leverage, openedAt: trade.openedAt, closedAt: trade.closedAt,
    status: trade.status, result: trade.result, tradersIn: trade.tradersIn, youCopied: trade.youCopied,
    cultId: trade.cultId, markerId: trade.markerId,
  } : target.kind !== 'trade' ? fallbackSummary(target) : null;

  return <div className="modal-backdrop trade-sheet-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="trade-sheet" role="dialog" aria-modal="true" aria-label="Trade details">
      <div className="trade-sheet-head"><span className="eyebrow">TRADE</span><button className="icon-button" title="Close trade details" onClick={onClose}><X size={18} /></button></div>
      {loading ? <p className="field-note">Loading trade...</p> : error ? <p className="wallet-warning">{error}</p> : summary && <>
        <button className="trade-sheet-member" onClick={() => { onClose(); onProfile(summary.member.id); }}><span className="room-avatar">{summary.member.name.slice(0, 1).toUpperCase()}</span><span><strong>{summary.member.name}</strong>{summary.member.address && <small>{shortAddress(summary.member.address)}</small>}</span><ArrowRight size={15} /></button>
        <div className="trade-sheet-title"><h2>{summary.symbol}</h2><span className="venue-badge">{summary.venue === 'perpl' ? 'Perpl' : 'Nad.fun'}</span></div>
        <div className="trade-sheet-tags"><span>{summary.side.toUpperCase()}</span>{summary.venue === 'perpl' && summary.leverage != null && <span>{summary.leverage}x</span>}{summary.youCopied && <span className="copied-label">You copied this</span>}</div>
        <div className="trade-sheet-facts"><div><span>OPENED</span><strong>{dateTime(summary.openedAt)}</strong></div>{summary.status === 'closed' && <div><span>CLOSED</span><strong>{dateTime(summary.closedAt)}</strong></div>}{summary.tradersIn != null && <div><span>TOGETHER</span><strong>{summary.tradersIn} {summary.tradersIn === 1 ? 'trader was' : 'traders were'} in</strong></div>}</div>
        {summary.status === 'open' ? <div className="trade-sheet-outcome"><span className="eyebrow">OPEN POSITION</span>{summary.cultId && summary.markerId ? <button className="primary full" onClick={() => onChart(summary.cultId!, summary.markerId!, summary.market)}>Open chart <ArrowRight size={15} /></button> : <p className="field-note">A Cult chart is not available for this trade.</p>}</div> : <div className="trade-sheet-outcome"><span className="eyebrow">RESULT</span>{summary.result ? <><strong className={(summary.result.returnPct ?? 0) >= 0 ? 'positive' : 'negative'}>{summary.result.returnPct == null ? '—' : `${summary.result.returnPct > 0 ? '+' : ''}${percent(summary.result.returnPct)}`}</strong><div className="trade-sheet-pnl">{summary.result.pnlUsd == null ? 'PnL verifying…' : signedDollars(summary.result.pnlUsd)}</div>{summary.venue === 'perpl' && <p className="trade-sheet-prices">{dollars(summary.result.entryPrice)} → {dollars(summary.result.exitPrice)}</p>}</> : <p className="field-note">Result verifying…</p>}</div>}
        {target.kind !== 'trade' && <button className="outline full trade-sheet-profile-link" onClick={() => { onClose(); onProfile(summary.member.id); }}>View profile <ArrowRight size={15} /></button>}
      </>}
    </section>
  </div>;
}
