'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Flame, Star, TrendingDown, TrendingUp, Zap } from './icons';
import { HotPill, isHotMarket } from './HotPill';
import { getMarkets } from '@/lib/api';
import { cachedList } from '@/lib/marketCache';
import type { MarketListing } from '@/lib/contracts';
import { compactDollars, price, signedPct } from '@/lib/format';
import { useStarred } from '@/lib/prefs';
import { TokenLogo } from './TokenLogo';
import { PredictionsBrowse, type PredictionPick } from './PredictionsBrowse';

// Every market on both venues, searchable, plus prediction markets. Drawn at once from the last list
// we saw; a fresh one replaces it quietly. A second view, Watchlist, lists the
// markets you've starred.

type Tab = 'perpl' | 'nadfun' | 'predictions';
type Mode = 'markets' | 'watchlist';
// Coming back from a market lands on the tab (and view) you left.
let lastTab: Tab = 'perpl';
let lastMode: Mode = 'markets';
// Open Markets on a given tab (e.g. Trade from a cult chat lands on Perps).
export const showMarketsTab = (tab: Tab) => { lastTab = tab; lastMode = 'markets'; };
const TABS: { id: Tab; label: string; title: string }[] = [
  { id: 'perpl', label: 'Perps', title: 'Trade perps' },
  { id: 'nadfun', label: 'Memes', title: 'Trade memes' },
  { id: 'predictions', label: 'Predictions', title: 'Call it' },
];
type Sort = 'volume' | 'gainers' | 'losers';

type Props = { owner: string; search: string; onOpen: (id: string) => void; onPredict: (slug: string, pick?: PredictionPick) => void; predictionRevision: number };

export function Change({ pct }: { pct: number | null }) {
  if (pct == null) return <small className="change">—</small>;
  const up = pct >= 0;
  return <small className={`change ${up ? 'up' : 'down'}`}>{up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{signedPct(pct)}</small>;
}

function MarketRow({ m, onOpen }: { m: MarketListing; onOpen: () => void }) {
  return <button className="mtable-row" role="row" onClick={onOpen}>
    <span className="mtable-market"><TokenLogo symbol={m.symbol} imageUri={m.imageUri} /><span><strong>{m.symbol}{isHotMarket(m.change24hPct) && <HotPill />}</strong><small>{m.venue === 'perpl' ? 'Perpetual' : m.name}</small></span></span>
    <span className="num strong">{price(m.priceUsd)}</span>
    <span><Change pct={m.change24hPct} /></span>
    <span className="num muted hide-sm">{compactDollars(m.volume24hUsd)}</span>
    <span className="hide-sm">{m.venue === 'perpl' ? <span className="lev-pill">{Math.floor(m.maxLeverage)}x</span> : <span className="lev-pill meme">Spot</span>}</span>
    <span className="mtable-go">Trade <ArrowRight size={14} /></span>
  </button>;
}
const TableHead = () => <div className="mtable-row mtable-head" role="row"><span>Market</span><span>Price</span><span>24h</span><span className="hide-sm">Volume</span><span className="hide-sm">Leverage</span><span /></div>;

// Your starred markets, from the full list (both venues), in the order you starred them.
function Watchlist({ owner, search, onOpen, onBrowse }: { owner: string; search: string; onOpen: (id: string) => void; onBrowse: () => void }) {
  const ids = useStarred(owner);
  const [all, setAll] = useState<MarketListing[] | null>(() => cachedList(''));
  useEffect(() => {
    let active = true;
    getMarkets().then(r => { if (active) setAll(r.markets); }).catch(() => { if (active) setAll(current => current ?? []); });
    return () => { active = false; };
  }, []);
  const query = search.trim().toLowerCase();
  const rows = useMemo(() => ids.map(id => all?.find(m => m.id === id)).filter((m): m is MarketListing => !!m)
    .filter(m => !query || m.symbol.toLowerCase().includes(query) || m.name?.toLowerCase().includes(query)), [ids, all, query]);
  return <section className="card flush table-card reveal">
    {!all ? <div className="mtable" role="table"><TableHead />{Array.from({ length: 4 }, (_, i) => <div key={i} className="mtable-row"><span className="skel skel-line" /></div>)}</div>
      : ids.length === 0 ? <div className="empty"><strong>Your watchlist is empty.</strong><span>Tap the <Star size={13} className="inline-star" /> on any market to keep it here.</span><div className="empty-actions"><button className="btn btn-primary btn-sm" onClick={onBrowse}>Browse markets</button></div></div>
        : <div className="mtable" role="table"><TableHead />
          {rows.length ? rows.map(m => <MarketRow key={`${m.venue}:${m.id}`} m={m} onOpen={() => onOpen(m.id)} />) : <div className="empty"><span>No watched markets match &ldquo;{search}&rdquo;.</span></div>}
        </div>}
  </section>;
}

export function MarketsView({ owner, search, onOpen, onPredict, predictionRevision }: Props) {
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (next: Tab) => { lastTab = next; setTabState(next); };
  const [mode, setModeState] = useState<Mode>(lastMode);
  const setMode = (next: Mode) => { lastMode = next; setModeState(next); };
  const [sort, setSort] = useState<Sort>('volume');
  const venue = tab === 'perpl' || tab === 'nadfun' ? tab : undefined;
  const [list, setList] = useState<MarketListing[] | null>(() => cachedList(search, venue));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const cached = cachedList(search, venue);
    if (cached) setList(cached);
    const timer = window.setTimeout(() => {
      getMarkets(search.trim(), venue)
        .then(r => { if (active) { setList(r.markets); setError(null); } })
        .catch(() => { if (active && !cached) setError('Markets are unavailable right now. Try again shortly.'); });
    }, cached ? 0 : 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, venue]);

  const sorted = useMemo(() => [...(list ?? [])].sort((a, b) => sort === 'volume' ? (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0) : sort === 'gainers' ? (b.change24hPct ?? -1e9) - (a.change24hPct ?? -1e9) : (a.change24hPct ?? 1e9) - (b.change24hPct ?? 1e9)), [list, sort]);
  const all = list ?? [];
  const highlights = all.length ? [
    { label: 'Top gainer', icon: <TrendingUp size={15} />, m: [...all].sort((a, b) => (b.change24hPct ?? -1e9) - (a.change24hPct ?? -1e9))[0] },
    { label: 'Most traded', icon: <Zap size={15} />, m: [...all].sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))[0] },
    { label: 'Hottest meme', icon: <Flame size={15} />, m: [...all].filter(x => x.venue === 'nadfun').sort((a, b) => (b.change24hPct ?? -1e9) - (a.change24hPct ?? -1e9))[0] },
  ].filter((h): h is { label: string; icon: React.ReactElement; m: MarketListing } => !!h.m) : [];
  const watching = mode === 'watchlist';

  return <div className="view one-col">
    <section className="view-main">
      <header className="page-head">
        <div><h1 className="display">{watching ? 'Watchlist' : TABS.find(t => t.id === tab)!.title}</h1></div>
        {(watching || tab !== 'predictions') && <div className="seg" role="radiogroup" aria-label="Markets or watchlist">
          <button role="radio" aria-checked={!watching} className={!watching ? 'on' : ''} onClick={() => setMode('markets')}>Markets</button>
          <button role="radio" aria-checked={watching} className={watching ? 'on' : ''} onClick={() => setMode('watchlist')}><Star size={14} /> Watchlist</button>
        </div>}
      </header>

      {watching ? <Watchlist owner={owner} search={search} onOpen={onOpen} onBrowse={() => setMode('markets')} /> : <>
      <div className="seg seg--scroll markets-tabs">{TABS.map(t => <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>

      {tab === 'predictions' ? <PredictionsBrowse search={search} revision={predictionRevision} onOpen={onPredict} /> : <>

      {highlights.length > 0 && !search.trim() && <div className="highlights reveal">{highlights.map(h => <button key={h.label} className="highlight" onClick={() => onOpen(h.m.id)}>
        <span className="eyebrow">{h.icon}{h.label}</span>
        <span className="highlight-main"><TokenLogo symbol={h.m.symbol} imageUri={h.m.imageUri} /><strong>{h.m.symbol}</strong></span>
        <span className="highlight-foot"><b className="num">{price(h.m.priceUsd)}</b><Change pct={h.m.change24hPct} /></span>
      </button>)}</div>}

      <section className="card flush table-card reveal" style={{ '--d': '80ms' } as React.CSSProperties}>
        <div className="table-tools"><div className="chips">{([['volume', 'Top volume'], ['gainers', 'Gainers'], ['losers', 'Losers']] as const).map(([id, label]) => <button key={id} className={sort === id ? 'on' : ''} onClick={() => setSort(id)}>{label}</button>)}</div></div>
        {error ? <p className="notice-line">{error}</p> : <div className="mtable" role="table">
          <TableHead />
          {!list ? Array.from({ length: 8 }, (_, i) => <div key={i} className="mtable-row"><span className="skel skel-line" /></div>)
            : sorted.length === 0 ? <div className="empty"><span>No markets match &ldquo;{search}&rdquo;.</span></div>
            : sorted.map(m => <MarketRow key={`${m.venue}:${m.id}`} m={m} onOpen={() => onOpen(m.id)} />)}
        </div>}
      </section>
      </>}
      </>}
    </section>
  </div>;
}
