'use client';

import { useEffect, useState } from 'react';
import { getMarkets } from '@/lib/api';
import { cachedList } from '@/lib/marketCache';
import type { MarketListing } from '@/lib/contracts';
import { price, signedPct } from '@/lib/format';
import { TokenLogo } from './TokenLogo';

// The terminal's bottom bar: connection state and a slow tape of the busiest
// perps. Click one to open it.

export function Ticker({ live, demo, onMarket, onExitDemo }: { live: boolean; demo: boolean; onMarket: (id: string) => void; onExitDemo: () => void }) {
  const [markets, setMarkets] = useState<MarketListing[]>(() => cachedList('') ?? []);
  useEffect(() => {
    let active = true;
    const load = () => getMarkets().then(r => { if (active) setMarkets(r.markets); }).catch(() => {});
    load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const tape = markets.filter(m => m.venue === 'perpl').sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)).slice(0, 12);
  const item = (m: MarketListing, copy: number) => <button key={`${copy}:${m.id}`} className="tape-item" onClick={() => onMarket(m.id)} tabIndex={copy ? -1 : 0}>
    <TokenLogo symbol={m.symbol} imageUri={m.imageUri} /><b>{m.symbol.replace(/-PERP$/, '')}</b><span className="num">{price(m.priceUsd)}</span><span className={`num ${(m.change24hPct ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(m.change24hPct)}</span>
  </button>;
  return <footer className="ticker" aria-label="Market ticker">
    <span className={`ticker-status ${live ? 'is-live' : ''}`}><i />{demo ? 'Demo data' : live ? 'Live' : 'Stable'}</span>
    <div className="tape"><div className="tape-track">{tape.map(m => item(m, 0))}{tape.map(m => item(m, 1))}</div></div>
    {demo ? <button className="ticker-demo" onClick={onExitDemo}>Exit demo</button> : <span className="ticker-net">Monad</span>}
  </footer>;
}
