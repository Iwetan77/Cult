'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Flame, TrendingDown, TrendingUp, Zap } from './icons';
import { getMarkets } from '@/lib/api';
import { cachedList } from '@/lib/marketCache';
import type { MarketListing } from '@/lib/contracts';
import { compactDollars, price, signedPct } from '@/lib/format';
import { TokenLogo } from './TokenLogo';
import { PredictionsBrowse, type PredictionPick } from './PredictionsBrowse';

// Every market on both venues, searchable, plus prediction markets. Drawn at once from the last list
// we saw; a fresh one replaces it quietly.

type Tab = 'perpl' | 'nadfun' | 'predictions';
// Coming back from a market lands on the tab you left.
let lastTab: Tab = 'perpl';
// Open Markets on a given tab (e.g. Trade from a cult chat lands on Perps).
export const showMarketsTab = (tab: Tab) => { lastTab = tab; };
const TABS: { id: Tab; label: string; title: string }[] = [
  { id: 'perpl', label: 'Perps', title: 'Trade perps' },
  { id: 'nadfun', label: 'Memes', title: 'Trade memes' },
  { id: 'predictions', label: 'Predictions', title: 'Call it' },
];
type Sort = 'volume' | 'gainers' | 'losers';

type Props = { search: string; onOpen: (id: string) => void; onPredict: (slug: string, pick?: PredictionPick) => void; predictionRevision: number };

export function Change({ pct }: { pct: number | null }) {
  if (pct == null) return <small className="change">—</small>;
  const up = pct >= 0;
  return <small className={`change ${up ? 'up' : 'down'}`}>{up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{signedPct(pct)}</small>;
}

export function MarketsView({ search, onOpen, onPredict, predictionRevision }: Props) {
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (next: Tab) => { lastTab = next; setTabState(next); };
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

  return <div className="view one-col">
    <section className="view-main">
      <header className="page-head">
        <div><span className="eyebrow">Markets</span><h1 className="display">{TABS.find(t => t.id === tab)!.title}</h1></div>
        <div className="seg seg--scroll">{TABS.map(t => <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
      </header>

      {tab === 'predictions' ? <PredictionsBrowse search={search} revision={predictionRevision} onOpen={onPredict} /> : <>

      {highlights.length > 0 && !search.trim() && <div className="highlights reveal">{highlights.map(h => <button key={h.label} className="highlight" onClick={() => onOpen(h.m.id)}>
        <span className="eyebrow">{h.icon}{h.label}</span>
        <span className="highlight-main"><TokenLogo symbol={h.m.symbol} imageUri={h.m.imageUri} /><strong>{h.m.symbol}</strong></span>
        <span className="highlight-foot"><b className="num">{price(h.m.priceUsd)}</b><Change pct={h.m.change24hPct} /></span>
      </button>)}</div>}

      <section className="card flush table-card reveal" style={{ '--d': '80ms' } as React.CSSProperties}>
        <div className="table-tools"><div className="chips">{([['volume', 'Top volume'], ['gainers', 'Gainers'], ['losers', 'Losers']] as const).map(([id, label]) => <button key={id} className={sort === id ? 'on' : ''} onClick={() => setSort(id)}>{label}</button>)}</div></div>
        {error ? <p className="notice-line">{error}</p> : <div className="mtable" role="table">
          <div className="mtable-row mtable-head" role="row"><span>Market</span><span>Price</span><span>24h</span><span className="hide-sm">Volume</span><span className="hide-sm">Leverage</span><span /></div>
          {!list ? Array.from({ length: 8 }, (_, i) => <div key={i} className="mtable-row"><span className="skel skel-line" /></div>)
            : sorted.length === 0 ? <div className="empty"><span>No markets match &ldquo;{search}&rdquo;.</span></div>
            : sorted.map(m => <button key={`${m.venue}:${m.id}`} className="mtable-row" role="row" onClick={() => onOpen(m.id)}>
              <span className="mtable-market"><TokenLogo symbol={m.symbol} imageUri={m.imageUri} /><span><strong>{m.symbol}</strong><small>{m.venue === 'perpl' ? 'Perpetual' : m.name}</small></span></span>
              <span className="num strong">{price(m.priceUsd)}</span>
              <span><Change pct={m.change24hPct} /></span>
              <span className="num muted hide-sm">{compactDollars(m.volume24hUsd)}</span>
              <span className="hide-sm">{m.venue === 'perpl' ? <span className="lev-pill">{Math.floor(m.maxLeverage)}x</span> : <span className="lev-pill meme">Spot</span>}</span>
              <span className="mtable-go">Trade <ArrowRight size={14} /></span>
            </button>)}
        </div>}
      </section>
      </>}
    </section>
  </div>;
}
