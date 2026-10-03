'use client';

import { useEffect, useMemo, useState } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { getAccessToken } from '@/lib/auth';
import { getPredictionPositions } from '@/lib/api';
import type { PredictionPosition, PredictionSide } from '@/lib/contracts';
import { compactDollars, dollars } from '@/lib/format';
import { CATEGORIES, cents, chance, endsIn, listEvents, type PredictionCategory, type PredictionEvent } from '@/lib/polymarket';

// The Predictions tab on Markets: live Polymarket events by category, and
// your open bets on top.

export type PredictionPick = { outcomeId: string; side: PredictionSide };
type Props = { search: string; revision: number; onOpen: (slug: string, pick?: PredictionPick) => void };

let lastCategory: PredictionCategory = CATEGORIES[0]!;

export function EventArt({ event, size = 'md' }: { event: Pick<PredictionEvent, 'image' | 'title'>; size?: 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  return <span className={`pm-art ${size}`}>{event.image && !failed
    // eslint-disable-next-line @next/next/no-img-element -- remote Polymarket art
    ? <img src={event.image} alt="" onError={() => setFailed(true)} />
    : <b>{event.title.trim()[0]?.toUpperCase() ?? '?'}</b>}</span>;
}

export function OddsChange({ change }: { change: number | null }) {
  if (change == null || Math.abs(change) < 0.005) return null;
  const up = change > 0;
  return <small className={`change ${up ? 'up' : 'down'}`}>{up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{Math.round(Math.abs(change) * 100)}%</small>;
}

export function PredictionsBrowse({ search, revision, onOpen }: Props) {
  const [category, setCategory] = useState<PredictionCategory>(lastCategory);
  const [events, setEvents] = useState<PredictionEvent[] | null>(null);
  const [positions, setPositions] = useState<PredictionPosition[]>([]);

  useEffect(() => {
    let active = true;
    lastCategory = category;
    setEvents(null);
    const load = () => listEvents(category).then(list => { if (active) setEvents(list); });
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [category]);

  useEffect(() => {
    let active = true;
    getAccessToken().then(token => token ? getPredictionPositions(token) : { positions: [], closed: [] }).then(r => { if (active) setPositions(r.positions); }).catch(() => undefined);
    return () => { active = false; };
  }, [revision]);

  const shown = useMemo(() => (events ?? []).filter(e => e.title.toLowerCase().includes(search.trim().toLowerCase()) || e.outcomes.some(o => o.label.toLowerCase().includes(search.trim().toLowerCase()))), [events, search]);

  return <>
    {positions.length > 0 && !search.trim() && <section className="block">
      <div className="block-head"><h2>Your predictions</h2><span className="count">{positions.length} open</span></div>
      <div className="pm-mine">{positions.map(p => <button key={p.id} className="pm-mine-row" onClick={() => onOpen(p.eventSlug, { outcomeId: p.marketId, side: p.side })}>
        <EventArt event={{ image: p.image, title: p.eventTitle }} />
        <span className="pm-mine-what"><strong>{p.outcomeLabel === p.question ? p.question : p.outcomeLabel}</strong><small>{p.outcomeLabel === p.question ? 'Polymarket' : p.eventTitle}</small></span>
        <span className={`side-chip ${p.side === 'yes' ? 'long' : 'short'}`}>{p.sideLabel.toUpperCase()}</span>
        <span className="pm-mine-num"><strong className="num">{dollars(p.costUsd)}</strong><small className="num">{Math.round(p.shares)} shares · avg {cents(p.avgPrice)}</small></span>
      </button>)}</div>
    </section>}

    <div className="chips chips--scroll pm-cats">{CATEGORIES.map(c => <button key={c.id} className={category.id === c.id ? 'on' : ''} onClick={() => setCategory(c)}>{c.label}</button>)}</div>

    {events == null ? <div className="pm-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="pm-card skel" />)}</div>
      : shown.length === 0 ? <div className="card"><div className="empty"><span>{search.trim() ? `No prediction markets match “${search.trim()}”.` : 'No live markets here right now.'}</span></div></div>
      : <div className="pm-grid">{shown.slice(0, 30).map((e, i) => <PredictionCard key={e.slug} event={e} index={i} onOpen={onOpen} />)}</div>}
    <p className="pm-source">Odds and markets from Polymarket.</p>
  </>;
}

function PredictionCard({ event, index, onOpen }: { event: PredictionEvent; index: number; onOpen: Props['onOpen'] }) {
  const lead = event.outcomes[0]!;
  const open = () => onOpen(event.slug);
  const pick = (outcomeId: string, side: PredictionSide) => (e: React.MouseEvent) => { e.stopPropagation(); onOpen(event.slug, { outcomeId, side }); };
  return <article className="pm-card reveal" style={{ '--d': `${Math.min(index, 8) * 40}ms` } as React.CSSProperties} role="button" tabIndex={0} aria-label={event.title}
    onClick={open} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }}>
    <div className="pm-card-top"><EventArt event={event} /><h3>{event.title}</h3></div>
    {event.multi ? <div className="pm-card-opts">{event.outcomes.slice(0, 3).map(o => <div key={o.id} className="pm-card-opt">
      <span className="pm-card-opt-name">{o.label}</span>
      <b className="num">{chance(o.yesPrice)}</b>
      <span className="pm-card-opt-btns"><button className="pm-yes" onClick={pick(o.id, 'yes')}>Yes</button><button className="pm-no" onClick={pick(o.id, 'no')}>No</button></span>
    </div>)}{event.outcomes.length > 3 && <small className="pm-card-more">+{event.outcomes.length - 3} more</small>}</div>
      : <div className="pm-card-binary">
        <div className="pm-card-chance"><strong className="num">{chance(lead.yesPrice)}</strong><span>{lead.yesLabel === 'Yes' ? 'chance' : lead.yesLabel}</span><OddsChange change={lead.change24h} /></div>
        <i className="pm-bar"><i style={{ width: `${lead.yesPrice * 100}%` }} /></i>
        <div className="pm-card-btns"><button className="pm-yes" onClick={pick(lead.id, 'yes')}>{lead.yesLabel} <b className="num">{cents(lead.yesPrice)}</b></button><button className="pm-no" onClick={pick(lead.id, 'no')}>{lead.noLabel} <b className="num">{cents(lead.noPrice)}</b></button></div>
      </div>}
    <div className="pm-card-foot"><span>{compactDollars(event.volume24h)} vol today</span>{endsIn(event.endDate) && <span>{endsIn(event.endDate)}</span>}</div>
  </article>;
}
