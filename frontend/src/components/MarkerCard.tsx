'use client';

import { ArrowRight, GripHorizontal, X } from 'lucide-react';
import type { ChartMarker, TpslSuggestion } from '@/lib/contracts';
import { dollars, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';

// The card that opens over the chart when you tap a position: whose it is,
// how it's doing, and what you can do with it right there. Yours: drag its
// TP/SL lines (real Perpl orders), accept suggestions, close. A cult-mate's:
// stack your own position on top, or drag their lines to suggest TP/SL.

type Props = {
  marker: ChartMarker;
  symbol: string;
  busy: boolean;
  now: number;
  avatarUrl?: string | null;
  stackUsd: string;
  onStackUsd: (value: string) => void;
  onStack: () => void;
  tpDraft: string;
  slDraft: string;
  onTpDraft: (value: string) => void;
  onSlDraft: (value: string) => void;
  onSaveLevels: () => void;
  onApplySuggestion: (suggestion: TpslSuggestion) => void;
  onSkip: () => void;
  onClosePosition: () => void;
  onDismiss: () => void;
};

const price = (value: number | null | undefined) => value == null ? '—' : dollars(value, value < 1 ? 6 : 2);
const originLabel = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? 'Auto copy' : origin === 'manual_stack' ? 'Stacked' : 'Own trade';

export function MarkerCard(p: Props) {
  const m = p.marker;
  const perp = m.venue === 'perpl';
  const pnl = perp ? m.pnlUsd : null;
  const skipLeft = m.skipUntil ? Math.ceil((Date.parse(m.skipUntil) - p.now) / 1000) : 0;
  const levels = perp && m.entryPrice != null;
  return <section className="marker-card" aria-label={`${m.memberName}'s position`}>
    <header className="marker-card-head">
      <Avatar name={m.memberName} url={p.avatarUrl} />
      <div><strong>{m.isMine ? 'You' : m.memberName}</strong><small>{originLabel(m.origin)} · {p.symbol}</small></div>
      <span className={`side-chip ${m.side}`}>{m.side.toUpperCase()}{perp && m.leverage ? ` ${m.leverage}x` : ''}</span>
      <button className="icon-button compact" title="Close" onClick={p.onDismiss}><X size={15} /></button>
    </header>
    <div className="marker-card-pnl">
      <span>{perp ? 'Live PnL' : 'Value'}</span>
      <strong className={perp ? ((pnl ?? 0) >= 0 ? 'positive' : 'negative') : ''}>{perp ? (pnl == null ? 'Pending' : signedDollars(pnl)) : (m.valueUsd == null ? 'Pending' : dollars(m.valueUsd))}</strong>
    </div>
    <dl className="marker-card-stats">
      <dt>Entry</dt><dd>{m.entryPrice == null ? 'Pending' : price(m.entryPrice)}</dd>
      <dt>Mark</dt><dd>{price(m.markPrice)}</dd>
      {m.size != null && <><dt>Size</dt><dd>{Number(m.size.toPrecision(6))}</dd></>}
      {levels && <><dt>TP</dt><dd className="positive">{price(m.takeProfitPrice)}</dd><dt>SL</dt><dd className="negative">{price(m.stopLossPrice)}</dd></>}
    </dl>

    {m.isMine && m.origin === 'auto_mirror' && m.mirrorStatus === 'pending' && skipLeft > 0 && <button className="outline full" disabled={p.busy} onClick={p.onSkip}>Skip this copy ({skipLeft}s)</button>}

    {levels && <>
      <p className="marker-card-hint"><GripHorizontal size={14} /> {m.isMine ? 'Drag the TP and SL handles on the chart to set real orders.' : `Drag ${m.memberName}'s TP and SL handles to suggest levels.`}</p>
      <div className="marker-card-levels">
        <label><span>TP $</span><input inputMode="decimal" value={p.tpDraft} onChange={event => p.onTpDraft(event.target.value)} /></label>
        <label><span>SL $</span><input inputMode="decimal" value={p.slDraft} onChange={event => p.onSlDraft(event.target.value)} /></label>
        <button className="outline" disabled={p.busy} onClick={p.onSaveLevels}>{m.isMine ? 'Set' : 'Suggest'}</button>
      </div>
    </>}

    {m.isMine && perp && !!m.suggestions?.length && <div className="marker-card-suggestions">
      <span className="ticket-label">Suggestions from your cult</span>
      {m.suggestions.map(s => <div key={s.id}><span><strong>{s.fromName}</strong> TP {price(s.takeProfitPrice)} · SL {price(s.stopLossPrice)}</span><button className="outline" disabled={p.busy} onClick={() => p.onApplySuggestion(s)}>Accept</button></div>)}
    </div>}

    {!m.isMine && <div className="marker-card-stack">
      <span className="ticket-label">Stack on this</span>
      <div><span className="ticket-prefix">$</span><input inputMode="decimal" value={p.stackUsd} onChange={event => p.onStackUsd(event.target.value.replace(/[^0-9.]/g, ''))} aria-label="Stack amount in dollars" />
        <button className="primary" disabled={p.busy} onClick={p.onStack}>{perp ? `Open ${m.side}` : 'Buy'} <ArrowRight size={14} /></button></div>
      <small>Opens the same {perp ? 'position' : 'buy'} in your own account.</small>
    </div>}

    {m.isMine && m.origin !== 'auto_mirror' && <button className="outline full danger-button" disabled={p.busy} onClick={p.onClosePosition}>Close position</button>}
  </section>;
}
