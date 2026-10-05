'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Share2, X } from './icons';
import type { ChartMarker, TpslSuggestion } from '@/lib/contracts';
import { dollars, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';

// The card that opens when you tap a position on the chart: whose it is,
// how it's doing, and what you can do with it right there. Yours: set TP/SL
// (real Perpl orders; the chart's handles drag them too), accept
// suggestions, share, close. A cult-mate's: stack your own position on top,
// or suggest TP/SL. Floats over the chart on wide screens; a bottom sheet on
// phones.

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
  onShare: () => void;
  onDismiss: () => void;
};

const price = (value: number | null | undefined) => value == null ? '—' : dollars(value, value < 1 ? 6 : 2);
const originLabel = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? 'Auto copy' : origin === 'manual_stack' ? 'Stacked' : 'Own trade';
const decimal = (value: string) => value.replace(/[^0-9.]/g, '');

const PHONE = '(max-width: 760px)';
function usePhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return phone;
}

export function MarkerCard(p: Props) {
  const phone = usePhone();
  const m = p.marker;
  const perp = m.venue === 'perpl';
  const pnl = perp ? m.pnlUsd : null;
  const leverage = Math.max(1, m.leverage || 1);
  const cost = perp && m.entryPrice != null && m.size ? (m.entryPrice * m.size) / leverage : null;
  const roi = pnl != null && cost ? (pnl / cost) * 100 : null;
  const skipLeft = m.skipUntil ? Math.ceil((Date.parse(m.skipUntil) - p.now) / 1000) : 0;
  const levels = perp && m.entryPrice != null;

  useEffect(() => {
    if (!phone) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') p.onDismiss(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [phone, p]);

  const card = <section className={`marker-card${phone ? ' is-sheet' : ''}`} role={phone ? 'dialog' : undefined} aria-modal={phone || undefined} aria-label={`${m.isMine ? 'Your' : `${m.memberName}'s`} position`}>
    <header className="marker-card-head">
      <Avatar name={m.memberName} url={p.avatarUrl} />
      <div><strong>{m.isMine ? 'You' : m.memberName}</strong><small>{originLabel(m.origin)} · {p.symbol}</small></div>
      <span className={`side-chip ${m.side}`}>{m.side.toUpperCase()}{perp && m.leverage ? ` ${m.leverage}x` : ''}</span>
      <button className="icon-btn icon-btn--sm" title="Close" onClick={p.onDismiss}><X size={15} /></button>
    </header>

    <div className={`marker-card-pnl ${perp ? ((pnl ?? 0) >= 0 ? 'is-up' : 'is-down') : ''}`}>
      <span>{perp ? 'Live PnL' : 'Value'}{roi != null && <em>{roi > 0 ? '+' : ''}{roi.toFixed(1)}%</em>}</span>
      <strong>{perp ? (pnl == null ? 'Pending' : signedDollars(pnl)) : (m.valueUsd == null ? 'Pending' : dollars(m.valueUsd))}</strong>
    </div>

    <dl className="marker-card-stats">
      <div><dt>Entry</dt><dd>{m.entryPrice == null ? 'Pending' : price(m.entryPrice)}</dd></div>
      <div><dt>Mark</dt><dd>{price(m.markPrice)}</dd></div>
      {m.size != null && <div><dt>Size</dt><dd>{Number(m.size.toPrecision(6))}</dd></div>}
    </dl>

    {m.isMine && m.origin === 'auto_mirror' && m.mirrorStatus === 'pending' && skipLeft > 0 && <button className="btn btn-ghost btn-sm btn-block" disabled={p.busy} onClick={p.onSkip}>Skip this copy ({skipLeft}s)</button>}

    {levels && <div className="marker-card-levels">
      <div className="marker-card-label"><span>{m.isMine ? 'Take profit · Stop loss' : 'Suggest TP · SL'}</span><small>or drag the handles on the chart</small></div>
      <div className="marker-card-fields">
        <Field label="TP" tone="up" value={p.tpDraft} onChange={p.onTpDraft} />
        <Field label="SL" tone="down" value={p.slDraft} onChange={p.onSlDraft} />
      </div>
      <button className="btn btn-ghost btn-sm btn-block" disabled={p.busy} onClick={p.onSaveLevels}>{m.isMine ? 'Set TP/SL' : `Suggest to ${m.memberName}`}</button>
    </div>}

    {m.isMine && perp && !!m.suggestions?.length && <div className="marker-card-suggestions">
      <span className="marker-card-label"><span>Suggestions from your cult</span></span>
      {m.suggestions.map(s => <div key={s.id}><span><strong>{s.fromName}</strong> TP {price(s.takeProfitPrice)} · SL {price(s.stopLossPrice)}</span><button className="btn btn-ghost btn-sm" disabled={p.busy} onClick={() => p.onApplySuggestion(s)}>Accept</button></div>)}
    </div>}

    {!m.isMine && <div className="marker-card-stack">
      <span className="marker-card-label"><span>Stack on this</span><small>Same {perp ? 'position' : 'buy'}, in your own account</small></span>
      <div><span className="ticket-prefix">$</span><input inputMode="decimal" value={p.stackUsd} onChange={event => p.onStackUsd(decimal(event.target.value))} aria-label="Stack amount in dollars" />
        <button className="btn btn-primary btn-sm" disabled={p.busy} onClick={p.onStack}>{perp ? `Open ${m.side}` : 'Buy'} <ArrowRight size={14} /></button></div>
    </div>}

    {m.isMine && <div className="marker-card-own">
      <button className="btn btn-ghost btn-sm" disabled={p.busy} onClick={p.onShare}><Share2 size={14} /> Share PnL card</button>
      {m.origin !== 'auto_mirror' && <button className="btn btn-danger btn-sm" disabled={p.busy} onClick={p.onClosePosition}>{perp ? 'Close position' : 'Sell all'}</button>}
    </div>}
  </section>;

  if (!phone) return card;
  // Inside the dashboard's own layer, so its other dialogs can stack above.
  return createPortal(<div className="modal-backdrop marker-sheet" onMouseDown={event => { if (event.target === event.currentTarget) p.onDismiss(); }}>{card}</div>, document.querySelector('.dash') ?? document.body);
}

function Field({ label, tone, value, onChange }: { label: string; tone: 'up' | 'down'; value: string; onChange: (value: string) => void }): ReactNode {
  return <label className={`marker-card-field is-${tone}`}>
    <span>{label}</span>
    <input inputMode="decimal" placeholder="None" value={value} onChange={event => onChange(decimal(event.target.value))} />
  </label>;
}
