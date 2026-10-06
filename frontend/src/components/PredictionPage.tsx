'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Share2 } from './icons';
import { getAccessToken } from '@/lib/auth';
import { getPredictionBets, getPredictionPositions, PREDICTIONS_SOON } from '@/lib/api';
import type { Me, PredictionBet, PredictionOrder, PredictionPosition, PredictionSide } from '@/lib/contracts';
import { compactDollars, dollars, signedDollars } from '@/lib/format';
import { cachedEvent, cents, chance, endsIn, getEvent, getHistory, type HistoryRange, type PredictionEvent, type PredictionOutcome } from '@/lib/polymarket';
import { Avatar } from './Avatar';
import { EventArt, OddsChange, type PredictionPick } from './PredictionsBrowse';
import { LINE_COLORS, PredictionChart, type ChartLine } from './PredictionChart';

// One prediction market: odds over time, every outcome, cult-mates' bets,
// your position, and a ticket to buy Yes or No. Live odds from Polymarket.

type Props = {
  slug: string; pick: PredictionPick | null; me: Me; canTrade: boolean; busy: string | null; revision: number;
  cults: { id: string; name: string }[];
  onBack: () => void; onBuy: (order: PredictionOrder) => void; onSell: (position: PredictionPosition, price: number) => void;
  onShare: (position: PredictionPosition, price: number) => void;
  onDeposit: () => void; onProfile: (memberId: string) => void;
};

const RANGES: { id: HistoryRange; label: string }[] = [{ id: '1d', label: '1D' }, { id: '1w', label: '1W' }, { id: '1m', label: '1M' }, { id: 'max', label: 'All' }];
const priceOf = (o: PredictionOutcome, side: PredictionSide) => side === 'yes' ? o.yesPrice : o.noPrice;
const nameOf = (event: PredictionEvent, o: PredictionOutcome) => event.multi ? o.label : event.title;

export function PredictionPage({ slug, pick, me, canTrade, busy, revision, cults, onBack, onBuy, onSell, onShare, onDeposit, onProfile }: Props) {
  const [event, setEvent] = useState<PredictionEvent | null>(() => cachedEvent(slug));
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(pick?.outcomeId ?? null);
  const [side, setSide] = useState<PredictionSide>(pick?.side ?? 'yes');
  const [range, setRange] = useState<HistoryRange>('1w');
  const [lines, setLines] = useState<ChartLine[]>([]);
  const [tab, setTab] = useState<'cult' | 'mine' | 'rules'>('cult');
  const [bets, setBets] = useState<PredictionBet[]>([]);
  const [positions, setPositions] = useState<PredictionPosition[]>([]);
  const ticketRef = useRef<HTMLElement>(null);

  // The event, refreshed for live odds.
  useEffect(() => {
    let active = true;
    const load = () => getEvent(slug).then(e => { if (active) { setEvent(e); setError(null); } }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'This market is unavailable.'); });
    void load();
    const timer = window.setInterval(load, 20_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [slug]);

  const outcome = event ? event.outcomes.find(o => o.id === selectedId) ?? event.outcomes[0]! : null;
  const charted = useMemo(() => event ? (event.multi ? event.outcomes.slice(0, 4) : event.outcomes.slice(0, 1)) : [], [event]);
  const chartKey = charted.map(o => o.id).join(',');

  useEffect(() => {
    if (!charted.length) return;
    let active = true;
    Promise.all(charted.map(o => getHistory(o, range).then(points => ({ id: o.id, label: o.label, points })))).then(next => { if (active) setLines(next); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch when the charted outcomes or range change, not on every odds tick
  }, [chartKey, range]);

  useEffect(() => {
    if (!event) return;
    let active = true;
    getAccessToken().then(async token => {
      if (!token) return;
      const [mine, cult] = await Promise.all([getPredictionPositions(token), getPredictionBets(token, slug, event.outcomes.map(o => ({ id: o.id, label: nameOf(event, o), yesPrice: o.yesPrice, yesLabel: o.yesLabel, noLabel: o.noLabel })))]);
      if (active) { setPositions(mine.positions.filter(p => p.eventSlug === slug)); setBets(cult.bets); }
    }).catch(() => undefined);
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per event load and after each trade
  }, [slug, !!event, revision]);

  if (error && !event) return <div className="view one-col"><section className="view-main"><button className="btn btn-ghost btn-sm" onClick={onBack}><ArrowLeft size={15} /> Predictions</button><p className="notice-line">{error}</p></section></div>;
  if (!event || !outcome) return <div className="view two-col"><section className="view-main"><div className="skel skel-head" /><div className="skel skel-chart" /></section><aside className="view-side"><div className="skel skel-card" /></aside></div>;

  const outcomeById = (id: string) => event.outcomes.find(o => o.id === id);
  const live = (p: { marketId: string; side: PredictionSide }) => { const o = outcomeById(p.marketId); return o ? priceOf(o, p.side) : null; };
  const ends = event.endDate ? new Date(event.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  // Picking from the outcome list brings the ticket into view if it isn't (phones).
  const choose = (o: PredictionOutcome, s: PredictionSide) => {
    setSelectedId(o.id); setSide(s);
    const top = ticketRef.current?.getBoundingClientRect().top;
    if (top != null && (top < 0 || top > window.innerHeight * 0.6)) ticketRef.current!.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return <div className="view two-col market-view pm-view">
    <section className="view-main">
      <section className="card mkt-bar pm-head">
        <button className="icon-btn" title="All predictions" onClick={onBack}><ArrowLeft size={16} /></button>
        <div className="mkt-bar-id">
          <EventArt event={event} />
          <div className="mkt-bar-name"><h1 title={event.title}>{event.title}</h1><small><span className="venue">Polymarket</span>{endsIn(event.endDate) ?? 'Prediction market'}</small></div>
        </div>
        <div className="mkt-bar-price"><strong className="num">{chance(outcome.yesPrice)}</strong><small>{event.multi ? `${outcome.label} chance` : 'Chance'}</small></div>
        <dl className="mkt-stats">
          <div><dt>24H change</dt><dd className={`num ${outcome.change24h == null ? '' : outcome.change24h >= 0 ? 'up' : 'down'}`}>{outcome.change24h == null ? '—' : `${outcome.change24h >= 0 ? '+' : '-'}${Math.round(Math.abs(outcome.change24h) * 100)}%`}</dd></div>
          <div><dt>24H volume</dt><dd className="num">{compactDollars(event.volume24h)}</dd></div>
          <div><dt>Total volume</dt><dd className="num">{compactDollars(event.volume)}</dd></div>
          <div><dt>Ends</dt><dd>{ends}</dd></div>
        </dl>
      </section>

      <section className="card chart-card">
        <div className="chart-tools">
          <div className="seg seg--sm">{RANGES.map(r => <button key={r.id} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>{r.label}</button>)}</div>
          {event.multi ? <div className="pm-legend">{charted.map((o, i) => <span key={o.id}><i style={{ background: LINE_COLORS[i] }} />{o.label} <b className="num">{chance(o.yesPrice)}</b></span>)}</div>
            : <div className="pm-legend"><span><i style={{ background: LINE_COLORS[0] }} />{outcome.yesLabel} <b className="num">{chance(outcome.yesPrice)}</b></span><OddsChange change={outcome.change24h} /></div>}
        </div>
        <div className="chart-wrap pm-chart-wrap">{lines.length ? <PredictionChart lines={lines} /> : <span className="skel pm-chart-skel" />}</div>
      </section>

      {event.multi && <section className="card flush">
        <div className="table-tools"><h2>Outcomes</h2></div>
        <div className="pm-outcomes">{event.outcomes.map(o => <div key={o.id} className={`pm-outcome ${outcome.id === o.id ? 'on' : ''}`} onClick={() => setSelectedId(o.id)}>
          <span className="pm-outcome-name"><strong>{o.label}</strong><small className="num">{compactDollars(o.volume24h)} vol</small></span>
          <span className="pm-outcome-chance"><b className="num">{chance(o.yesPrice)}</b><OddsChange change={o.change24h} /></span>
          <span className="pm-outcome-btns">
            <button className={`pm-yes ${outcome.id === o.id && side === 'yes' ? 'on' : ''}`} onClick={e => { e.stopPropagation(); choose(o, 'yes'); }}>Yes <b className="num">{cents(o.yesPrice)}</b></button>
            <button className={`pm-no ${outcome.id === o.id && side === 'no' ? 'on' : ''}`} onClick={e => { e.stopPropagation(); choose(o, 'no'); }}>No <b className="num">{cents(o.noPrice)}</b></button>
          </span>
        </div>)}</div>
      </section>}

      <section className="card pm-bets">
        <div className="tabs">
          <button className={tab === 'cult' ? 'on' : ''} onClick={() => setTab('cult')}>Cult bets</button>
          <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My position</button>
          <button className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Rules</button>
        </div>
        {tab === 'cult' ? (bets.length ? <div className="feed">{bets.map(b => {
          const now = live(b);
          const pnl = now == null ? null : b.shares * (now - b.avgPrice);
          return <button key={`${b.memberId}:${b.marketId}`} className="feed-row" onClick={() => onProfile(b.memberId)}>
            <Avatar name={b.memberName} url={b.avatarUrl} />
            <span className="feed-who"><strong>{b.memberName}</strong><small>{event.multi ? `${b.outcomeLabel} · ` : ''}avg {cents(b.avgPrice)}{now != null ? ` → ${cents(now)}` : ''} · {b.cultName}</small></span>
            <span className={`side-chip ${b.side === 'yes' ? 'long' : 'short'}`}>{b.sideLabel.toUpperCase()}</span>
            <b className={`num ${(pnl ?? 0) >= 0 ? 'up' : 'down'}`}>{pnl == null ? '—' : signedDollars(pnl)}</b>
          </button>;
        })}</div> : <div className="empty"><strong>No cult-mates on this one yet.</strong><span>{cults.length ? 'Place a bet and it posts to your cults.' : 'Join a cult to see your friends’ bets here.'}</span></div>)
        : tab === 'mine' ? (positions.length ? <div className="pm-positions">{positions.map(p => {
          const now = live(p);
          const value = now == null ? null : p.shares * now;
          const pnl = value == null ? null : value - p.costUsd;
          return <div key={p.id} className="my-pos">
            <div className="my-pos-grid">
              <div><span>Outcome</span><b><span className={`side-chip ${p.side === 'yes' ? 'long' : 'short'}`}>{p.sideLabel.toUpperCase()}</span>{p.outcomeLabel !== p.question ? ` ${p.outcomeLabel}` : ''}</b></div>
              <div><span>Shares</span><b className="num">{p.shares.toFixed(1)}</b></div>
              <div><span>Avg price</span><b className="num">{cents(p.avgPrice)}</b></div>
              <div><span>Now</span><b className="num">{now == null ? '—' : cents(now)}</b></div>
              <div><span>Value</span><b className="num">{value == null ? '—' : dollars(value)}</b></div>
              <div><span>PnL</span><b className={`num ${(pnl ?? 0) >= 0 ? 'up' : 'down'}`}>{pnl == null ? '—' : signedDollars(pnl)}</b></div>
            </div>
            <p className="ticket-note">Pays {dollars(p.shares)} if it resolves {p.sideLabel}.</p>
            <div className="my-pos-actions">
              <button className="btn btn-ghost btn-sm" disabled={now == null} onClick={() => now != null && onShare(p, now)}><Share2 size={14} /> Share card</button>
              <button className="btn btn-danger btn-sm" disabled={!!busy || now == null} onClick={() => now != null && onSell(p, now)}>Sell {now != null ? `for ${dollars(p.shares * now)}` : ''}</button>
            </div>
          </div>;
        })}</div> : <div className="empty"><span>You have no position here. Use the ticket to place a bet.</span></div>)
        : <div className="pm-rules">
          <p>{event.description || 'Resolution rules are on Polymarket.'}</p>
          <dl className="about">
            <div><dt>Ends</dt><dd>{ends}</dd></div>
            <div><dt>Venue</dt><dd>Polymarket (Polygon)</dd></div>
            <div><dt>Payout</dt><dd>$1 per winning share</dd></div>
            <div><dt>Liquidity</dt><dd className="num">{compactDollars(event.liquidity)}</dd></div>
          </dl>
          <a className="link" href={`https://polymarket.com/event/${encodeURIComponent(event.slug)}`} target="_blank" rel="noreferrer">View on Polymarket</a>
        </div>}
      </section>
    </section>

    <aside className="view-side">
      <section className="card ticket-card" ref={ticketRef}>
        <div className="card-head"><h2>Predict</h2><span className="count num">{chance(outcome.yesPrice)}</span></div>
        <PredictionTicket key={`${outcome.id}`} event={event} outcome={outcome} side={side} onSide={setSide} me={me} canTrade={canTrade} busy={busy === 'predict'} cults={cults} onBuy={onBuy} onDeposit={onDeposit} />
      </section>
    </aside>
  </div>;
}

function PredictionTicket({ event, outcome, side, onSide, me, canTrade, busy, cults, onBuy, onDeposit }: {
  event: PredictionEvent; outcome: PredictionOutcome; side: PredictionSide; onSide: (side: PredictionSide) => void; me: Me; canTrade: boolean; busy: boolean;
  cults: { id: string; name: string }[]; onBuy: (order: PredictionOrder) => void; onDeposit: () => void;
}) {
  const [amountText, setAmountText] = useState('');
  const [postTo, setPostTo] = useState('all');
  const price = priceOf(outcome, side);
  const sideLabel = side === 'yes' ? outcome.yesLabel : outcome.noLabel;
  const amount = Number(amountText) || 0;
  const shares = price > 0 ? amount / price : 0;
  const available = me.balances?.walletUsd ?? null;
  const tooBig = available != null && amount > available + 1e-9;
  const tradable = price > 0.001 && price < 0.999;
  const valid = canTrade && tradable && amount >= 1 && !tooBig;
  const what = event.multi ? `${outcome.label}: ${sideLabel}` : sideLabel;
  const cultIds = cults.length === 0 || postTo === 'all' ? undefined : postTo === 'none' ? [] : [postTo];

  const submit = () => {
    if (!valid) return;
    onBuy({ marketId: outcome.id, eventSlug: event.slug, eventTitle: event.title, outcomeLabel: event.multi ? outcome.label : outcome.question, question: outcome.question, image: event.image,
      side, sideLabel, price, amountUsd: amount, cultIds });
    setAmountText('');
  };

  return <div className="ticket">
    {event.multi && <div className="pm-ticket-for"><span className="ticket-label">Outcome</span><strong>{outcome.label}</strong></div>}
    <div className="pm-sides">
      <button className={`pm-side yes ${side === 'yes' ? 'on' : ''}`} onClick={() => onSide('yes')}><span>{outcome.yesLabel}</span><b className="num">{cents(outcome.yesPrice)}</b></button>
      <button className={`pm-side no ${side === 'no' ? 'on' : ''}`} onClick={() => onSide('no')}><span>{outcome.noLabel}</span><b className="num">{cents(outcome.noPrice)}</b></button>
    </div>

    <div className="ticket-amount">
      <div className="ticket-row"><label className="ticket-label" htmlFor="pm-amount">Amount</label><span className="ticket-avail">Available <b className="num">{available == null ? '—' : dollars(available)}</b></span></div>
      <div className="ticket-input"><span className="ticket-prefix">$</span><input id="pm-amount" className="num" inputMode="decimal" placeholder="0" value={amountText} onChange={e => setAmountText(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} /></div>
      <div className="ticket-quick">{[5, 25, 100, 500].map(q => <button type="button" key={q} onClick={() => setAmountText(String(q))}>${q}</button>)}</div>
    </div>

    <dl className="ticket-summary">
      <div><dt>Price</dt><dd className="num">{cents(price)} · {chance(price)} implied</dd></div>
      <div><dt>Shares</dt><dd className="num">{shares > 0 ? shares.toFixed(1) : '—'}</dd></div>
      <div className="pm-win"><dt>To win</dt><dd className="num">{shares > 0 ? <>{dollars(shares)} <small className="up">({signedDollars(shares - amount)})</small></> : '—'}</dd></div>
    </dl>
    {tooBig && <p className="ticket-warn">More than you have available.<button type="button" className="link" onClick={onDeposit}>Deposit</button></p>}
    {!tradable && <p className="ticket-note">This outcome is all but decided, so it can&rsquo;t be bought.</p>}

    {cults.length > 0 && <label className="ticket-post">
      <span className="ticket-label">Post to</span>
      <select value={postTo} onChange={e => setPostTo(e.target.value)}>
        <option value="all">All my cults ({cults.length})</option>
        {cults.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="none">Only me (private)</option>
      </select>
    </label>}

    <button type="button" className={`ticket-submit ticket-submit--stack ${side === 'no' ? 'short' : 'long'}`} disabled={!valid || busy} onClick={submit}>
      {canTrade ? `Buy ${what}` : 'Coming soon'}<small className="num">{canTrade ? (amount > 0 ? `${dollars(amount)} at ${cents(price)}` : 'Each share pays $1 if right') : 'Try it in the demo'}</small>
    </button>
    <p className="ticket-foot">{canTrade ? `Each share pays $1 if this resolves ${sideLabel}, $0 if not. Odds from Polymarket.` : PREDICTIONS_SOON}</p>
  </div>;
}
