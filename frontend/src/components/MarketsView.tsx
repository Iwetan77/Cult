'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, TrendingDown, TrendingUp } from 'lucide-react';
import { getMarket, getMarkets } from '@/lib/api';
import type { Market, MarketDetail, MarketListing } from '@/lib/contracts';
import { dollars } from '@/lib/format';
import { SharedChart } from './SharedChart';

type Tab = 'all' | 'perpl' | 'nadfun';
type Side = 'long' | 'short' | 'buy';

type Props = {
  search: string;
  openId: string | null;
  onOpen: (id: string | null) => void;
  busy: boolean;
  onTrade: (market: MarketListing, side: Side, amountUsd: number, leverage?: number) => Promise<void>;
};

const RESOLUTIONS: { label: string; seconds: number }[] = [
  { label: '5m', seconds: 300 },
  { label: '1h', seconds: 3600 },
  { label: '1D', seconds: 86400 },
];

const price = (v: number | null) => (v == null ? '—' : v >= 1 ? dollars(v) : `$${v.toPrecision(3)}`);

function Change({ pct }: { pct: number | null }) {
  if (pct == null) return <small className="market-change">—</small>;
  const up = pct >= 0;
  return <small className={`market-change ${up ? 'positive' : 'negative'}`}>{up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{up ? '+' : ''}{pct.toFixed(2)}%</small>;
}

function MarketIcon({ market }: { market: MarketListing }) {
  // Token art comes from Nad.fun's CDN at any size; a plain img keeps it simple.
  // eslint-disable-next-line @next/next/no-img-element
  if (market.imageUri) return <img className="market-icon" src={market.imageUri} alt="" />;
  return <span className="market-icon letter">{market.symbol.replace('$', '').slice(0, 1)}</span>;
}

export function MarketsView({ search, openId, onOpen, busy, onTrade }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [list, setList] = useState<MarketListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (openId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      getMarkets(search.trim(), tab === 'all' ? undefined : tab)
        .then((r) => { if (active) { setList(r.markets); setError(null); } })
        .catch(() => { if (active) setError('Markets are unavailable right now. Try again shortly.'); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, tab, openId]);

  if (openId) return <MarketPage id={openId} onBack={() => onOpen(null)} busy={busy} onTrade={onTrade} />;

  return <main className="full-workspace markets-screen">
    <div className="markets-head"><div><span className="eyebrow">MARKETS</span><h1>Trade perps and memes</h1></div>
      <div className="markets-tabs">{(['all', 'perpl', 'nadfun'] as Tab[]).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t === 'all' ? 'All' : t === 'perpl' ? 'Perps' : 'Memes'}</button>)}</div>
    </div>
    {error ? <p className="wallet-warning">{error}</p> : !list ? <p className="field-note">Loading markets...</p> : list.length === 0 ? <p className="field-note">No markets match &ldquo;{search}&rdquo;.</p> :
      <div className="market-list">{list.map((m) => <button key={`${m.venue}:${m.id}`} className="market-row" onClick={() => onOpen(m.id)}>
        <MarketIcon market={m} />
        <span className="market-name"><strong>{m.symbol}</strong><small>{m.venue === 'perpl' ? `Perp · up to ${m.maxLeverage}x` : m.name}</small></span>
        <span className="market-price"><strong>{price(m.priceUsd)}</strong><Change pct={m.change24hPct} /></span>
      </button>)}</div>}
  </main>;
}

function MarketPage({ id, onBack, busy, onTrade }: { id: string; onBack: () => void; busy: boolean; onTrade: Props['onTrade'] }) {
  const [resolution, setResolution] = useState(3600);
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [amount, setAmount] = useState('25');
  const [leverage, setLeverage] = useState('2');

  useEffect(() => {
    let active = true;
    getMarket(id, resolution)
      .then((d) => { if (active) { setDetail(d); setError(null); } })
      .catch(() => { if (active) setError('This market could not be loaded.'); });
    return () => { active = false; };
  }, [id, resolution]);

  const m = detail?.market;
  const isPerp = m?.venue === 'perpl';
  const chartMarket: Market | null = m ? { venue: m.venue, id: m.id, symbol: m.symbol, baseSymbol: m.symbol.replace('-PERP', '').replace('$', ''), quoteSymbol: 'USD', maxLeverage: m.maxLeverage, makerFeeBps: null, takerFeeBps: null } : null;
  const amountUsd = Number(amount);
  const lev = Number(leverage);
  const valid = Number.isFinite(amountUsd) && amountUsd > 0 && (!isPerp || (Number.isFinite(lev) && lev >= 1 && lev <= (m?.maxLeverage ?? 1)));

  return <main className="full-workspace market-page">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> All markets</button>
    {error ? <p className="wallet-warning">{error}</p> : !m || !chartMarket ? <p className="field-note">Loading market...</p> : <div className="market-page-grid">
      <section className="market-page-main">
        <div className="market-page-head"><MarketIcon market={m} /><div><h1>{m.symbol}</h1><small>{isPerp ? `Perpetual · up to ${m.maxLeverage}x` : m.name}</small></div>
          <div className="market-page-price"><strong>{price(m.priceUsd)}</strong><Change pct={m.change24hPct} /></div></div>
        <div className="markets-tabs small">{RESOLUTIONS.map((r) => <button key={r.seconds} className={resolution === r.seconds ? 'active' : ''} onClick={() => setResolution(r.seconds)}>{r.label}</button>)}</div>
        <div className="market-chart"><SharedChart candles={detail!.candles} markers={[]} market={chartMarket} selectedId={null} onSelect={() => {}} onGuideDrop={() => {}} guidesDisabled /></div>
        {m.volume24hUsd != null && <p className="field-note">24h volume {dollars(m.volume24hUsd, 0)}</p>}
      </section>
      <aside className="trade-ticket">
        <span className="eyebrow">{isPerp ? 'OPEN A POSITION' : 'BUY'}</span>
        {isPerp && <div className="side-toggle"><button className={side === 'long' ? 'active long' : ''} onClick={() => setSide('long')}>Long</button><button className={side === 'short' ? 'active short' : ''} onClick={() => setSide('short')}>Short</button></div>}
        <label className="field-label" htmlFor="ticket-amount">{isPerp ? 'MARGIN ($)' : 'AMOUNT ($)'}</label>
        <input id="ticket-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        {isPerp && <><label className="field-label" htmlFor="ticket-lev">LEVERAGE (1–{m.maxLeverage}x)</label><input id="ticket-lev" inputMode="decimal" value={leverage} onChange={(e) => setLeverage(e.target.value)} />
          {valid && <p className="field-note">Position size {dollars(amountUsd * lev)}</p>}</>}
        <button className="primary full" disabled={!valid || busy} onClick={() => void onTrade(m, isPerp ? side : 'buy', amountUsd, isPerp ? lev : undefined)}>{busy ? 'Placing…' : isPerp ? `${side === 'long' ? 'Long' : 'Short'} ${m.symbol}` : `Buy ${m.symbol}`}</button>
        <p className="field-note">Cult-mates with Auto-follow on will copy this trade, sized to their own limits.</p>
      </aside>
    </div>}
  </main>;
}
