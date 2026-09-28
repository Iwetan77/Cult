'use client';

import { useEffect, useState } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { getMarkets } from '@/lib/api';
import { cachedList } from '@/lib/marketCache';
import type { MarketListing } from '@/lib/contracts';
import { dollars } from '@/lib/format';
import { TokenLogo } from './TokenLogo';

// Every market on both venues, searchable. Drawn at once from the last list
// we saw; a fresh one replaces it quietly.

type Tab = 'all' | 'perpl' | 'nadfun';

type Props = { search: string; onOpen: (id: string) => void };

const price = (v: number | null) => (v == null ? '—' : v >= 1 ? dollars(v) : `$${v.toPrecision(3)}`);

export function Change({ pct }: { pct: number | null }) {
  if (pct == null) return <small className="market-change">—</small>;
  const up = pct >= 0;
  return <small className={`market-change ${up ? 'positive' : 'negative'}`}>{up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{up ? '+' : ''}{pct.toFixed(2)}%</small>;
}

export function MarketsView({ search, onOpen }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const venue = tab === 'all' ? undefined : tab;
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

  return <main className="full-workspace markets-screen">
    <div className="markets-head"><div><span className="eyebrow">MARKETS</span><h1>Trade perps and memes</h1></div>
      <div className="markets-tabs">{(['all', 'perpl', 'nadfun'] as Tab[]).map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t === 'all' ? 'All' : t === 'perpl' ? 'Perps' : 'Memes'}</button>)}</div>
    </div>
    {error ? <p className="wallet-warning">{error}</p> : !list ? <div className="market-list">{Array.from({ length: 8 }, (_, i) => <div key={i} className="market-row skeleton-row" />)}</div> : list.length === 0 ? <p className="field-note">No markets match &ldquo;{search}&rdquo;.</p> :
      <div className="market-list">{list.map(m => <button key={`${m.venue}:${m.id}`} className="market-row" onClick={() => onOpen(m.id)}>
        <TokenLogo symbol={m.symbol} imageUri={m.imageUri} className="market-icon" />
        <span className="market-name"><strong>{m.symbol}</strong><small>{m.venue === 'perpl' ? `Perp · up to ${m.maxLeverage}x` : m.name}</small></span>
        <span className="market-price"><strong>{price(m.priceUsd)}</strong><Change pct={m.change24hPct} /></span>
      </button>)}</div>}
  </main>;
}
