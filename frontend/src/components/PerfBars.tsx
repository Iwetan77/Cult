'use client';

import { useEffect, useMemo, useState } from 'react';
import { signedDollars, dollars } from '@/lib/format';

// Performance as bars, one per period: the solid bar is that period's PnL,
// the ghost behind it the running total at its end. Hover or tap a bar for
// its card; the latest one is picked to start. Used by Account and the cult
// preview.

// short: the label on phones, where columns are narrow.
export type PerfBar = { key: string; label: string; short?: string; title: string; value: number; total: number; note?: string };

type Props = {
  bars: PerfBar[];
  // Bars outside the chosen period are dimmed (all lit by default).
  lit?: (index: number) => boolean;
  valueLabel?: string;
  totalLabel?: string;
};

// Cents only on small amounts.
const money = (v: number, signed: boolean) => { const a = Math.abs(v), d = a >= 1000 ? 0 : 2; return `${v < 0 ? '-' : signed && v > 0 ? '+' : ''}${dollars(a, d)}`; };
const compact = (v: number) => {
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return `${sign}$${Math.round(a)}`;
};

// A clean axis: 3 to 6 steps of 1, 2, 2.5 or 5 × 10ⁿ covering every value.
function axis(values: number[]) {
  let min = Math.min(0, ...values), max = Math.max(0, ...values);
  if (max - min < 1e-9) max = min + 100;
  const rough = (max - min) / 5, mag = 10 ** Math.floor(Math.log10(rough)), norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  min = Math.floor(min / step + 1e-9) * step; max = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return { min, max, ticks };
}

export function PerfBars({ bars, lit = () => true, valueLabel = 'PnL', totalLabel = 'Running total' }: Props) {
  // Start on the latest bar that moved (a quiet today shows nothing).
  const last = bars.length - 1;
  const start = Math.max(0, bars.findLastIndex(b => b.value !== 0));
  const [active, setActive] = useState(start);
  const barsKey = bars.map(b => b.key).join('|');
  useEffect(() => { setActive(start); }, [barsKey, start]);

  const { min, max, ticks } = useMemo(() => axis(bars.flatMap(b => [b.value, b.total])), [bars]);
  const y = (v: number) => ((v - min) / (max - min)) * 100;
  const span = (a: number, b: number) => ({ bottom: `${Math.min(y(a), y(b))}%`, height: `${Math.max(Math.abs(y(b) - y(a)), 0.8)}%` });

  const n = bars.length, on = bars[active] ?? bars[last];
  if (!on) return null;
  const colPct = 100 / n, center = (active + 0.5) * colPct;
  const top = Math.max(y(on.value), y(0));
  const up = on.value >= 0;
  // Many narrow bars: the card sits beside the bar, on whichever side has
  // more room. A few wide ones: centred above it, so it never hides a neighbour.
  const place = n <= 4
    ? { left: `clamp(0px, calc(${center}% - var(--pbars-tip) / 2), calc(100% - var(--pbars-tip)))`, top: `max(0px, calc(${100 - top}% - var(--pbars-tip-h) - 14px))` }
    : { ...(center < 50
      ? { left: `min(calc(${center + colPct / 2}% + 6px), calc(100% - var(--pbars-tip)))` }
      : { right: `min(calc(${100 - center + colPct / 2}% + 6px), calc(100% - var(--pbars-tip)))` }),
      top: `clamp(0px, calc(${100 - top}% - 44px), calc(100% - var(--pbars-tip-h)))` };

  return <div className="pbars">
    <div className="pbars-plot">
      <div className="pbars-axis" aria-hidden="true">{ticks.map(t => <span key={t} className={t === 0 ? 'is-zero' : undefined} style={{ bottom: `${y(t)}%` }}><b>{compact(t)}</b></span>)}</div>
      <div className="pbars-cols">
        {bars.map((b, i) => <button key={b.key} type="button" className={`pbars-col${i === active ? ' on' : ''}${lit(i) ? '' : ' is-dim'}`}
          aria-label={`${b.title}: ${valueLabel} ${signedDollars(b.value)}, ${totalLabel.toLowerCase()} ${signedDollars(b.total)}`}
          onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onClick={() => setActive(i)}>
          <span className="pbars-ghost" style={span(0, b.total)} />
          <span className={`pbars-bar ${b.value >= 0 ? 'is-up' : 'is-down'}`} style={span(0, b.value)} />
          {i === active && <i className={`pbars-dot ${b.value >= 0 ? 'is-up' : 'is-down'}`} style={{ bottom: `${y(b.value)}%` }} />}
        </button>)}
        <div className="pbars-tip" role="status" style={place}>
          <strong>{on.title}</strong>
          <span><i className={up ? 'is-up' : 'is-down'} />{valueLabel}<b className={up ? 'up' : 'down'}>{money(on.value, true)}</b></span>
          <span><i className="is-ghost" />{totalLabel}<b>{money(on.total, false)}</b></span>
          {on.note && <small>{on.note}</small>}
        </div>
      </div>
    </div>
    <div className="pbars-x" aria-hidden="true">{bars.map((b, i) => <span key={b.key} className={i === active ? 'on' : undefined}><span className="pbars-lg">{b.label}</span><span className="pbars-sm">{b.short ?? b.label}</span></span>)}</div>
  </div>;
}
