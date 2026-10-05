'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Star } from './icons';
import { getMarket } from '@/lib/api';
import { cachedMarket } from '@/lib/marketCache';
import type { BackendConfig, ChartMarker, ChartSnapshot, Clan, Holding, Market, MarketDetail, Me, TpslSuggestion, TpslValues } from '@/lib/contracts';
import { setChartStylePref, toggleStar, useChartStylePref, useStarred } from '@/lib/prefs';
import { PriceAlertControl } from './AlertsMenu';
import { compactDollars, dollars, price, signedDollars, signedPct } from '@/lib/format';
import { SharedChart, type ChartStyle } from './SharedChart';
import { TokenLogo } from './TokenLogo';
import { Avatar } from './Avatar';
import { MarkerCard } from './MarkerCard';
import { TradeTicket, type PostTo, type TicketMarket } from './TradeTicket';

// A market is also its cult's chart: pick one of your cults and every
// cult-mate's position on this market is drawn on it, with name and live PnL.
// Tap one to stack on it or suggest TP/SL; drag your own lines to set real
// orders. "Off" is the plain chart.

export type MarketSocial = {
  cults: Clan[];
  cultId: string | null; // null = just me
  onCult: (id: string | null) => void;
  snapshot: ChartSnapshot | null;
  live: boolean;
  selected: ChartMarker | null;
  onSelect: (marker: ChartMarker | null) => void;
  onGuideDrop: (marker: ChartMarker, kind: 'takeProfit' | 'stopLoss', price: number) => void;
  resolution: number;
  onResolution: (seconds: number) => void;
  now: number;
  stackUsd: string; onStackUsd: (value: string) => void; onStack: () => void;
  tpDraft: string; slDraft: string; onTpDraft: (value: string) => void; onSlDraft: (value: string) => void; onSaveLevels: () => void;
  onApplySuggestion: (suggestion: TpslSuggestion) => void;
  onSkip: () => void;
  onClosePosition: (marketId: string) => void;
  onShare: (marker: ChartMarker) => void;
};

type Props = {
  id: string;
  me: Me;
  config: BackendConfig | null;
  busy: string | null;
  social: MarketSocial;
  holdings: Holding[];
  onBack: () => void;
  onTrade: (market: TicketMarket, side: 'long' | 'short' | 'buy', marginUsd: number, leverage: number | undefined, cultIds: string[] | undefined, tpsl?: TpslValues) => void;
  onDeposit: () => void;
  onProfile: (memberId: string) => void;
};

const RESOLUTIONS = [{ label: '5m', seconds: 300 }, { label: '1H', seconds: 3600 }, { label: '1D', seconds: 86400 }];
const originName = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? 'Auto copy' : origin === 'manual_stack' ? 'Stacked' : 'Own trade';

export function MarketPage({ id, me, config, busy, social, holdings, onBack, onTrade, onDeposit, onProfile }: Props) {
  const resolution = social.resolution;
  const [detail, setDetail] = useState<MarketDetail | null>(() => cachedMarket(id, resolution));
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'cult' | 'mine' | 'about'>('cult');
  const chartStyle: ChartStyle = useChartStylePref();
  const setChartStyle = setChartStylePref;
  const starred = useStarred(me.id).includes(id);
  // Turning friends back on returns to the cult you last had on.
  const [friendsCult, setFriendsCult] = useState<string | null>(social.cultId ?? social.cults[0]?.id ?? null);
  useEffect(() => { if (social.cultId) setFriendsCult(social.cultId); }, [social.cultId]);
  useEffect(() => {
    let active = true;
    setDetail(cachedMarket(id, resolution));
    getMarket(id, resolution)
      .then(d => { if (active) { setDetail(d); setError(null); } })
      .catch(() => { if (active) setError('This market could not be loaded.'); });
    const timer = window.setInterval(() => { void getMarket(id, resolution).then(d => { if (active) setDetail(d); }).catch(() => {}); }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [id, resolution]);

  const m = detail?.market;
  const isPerp = m?.venue === 'perpl';
  const cult = social.cults.find(c => c.id === social.cultId) ?? null;
  const snap = cult && social.snapshot?.clan.id === cult.id && social.snapshot.selectedMarket.id.toLowerCase() === id.toLowerCase() ? social.snapshot : null;
  const markers = useMemo(() => snap?.markers.filter(x => x.marketId.toLowerCase() === id.toLowerCase()) ?? [], [snap, id]);
  const candles = snap?.candles.length ? snap.candles : detail?.candles ?? [];
  const chartMarket: Market | null = m ? { venue: m.venue, id: m.id, symbol: m.symbol, baseSymbol: m.symbol.replace('-PERP', '').replace('$', ''), quoteSymbol: 'USD', maxLeverage: m.maxLeverage, makerFeeBps: null, takerFeeBps: null } : null;
  const selected = social.selected && markers.some(x => x.id === social.selected!.id) ? social.selected : null;
  const avatarOf = (memberId: string) => snap?.members.find(x => x.id === memberId)?.avatarUrl ?? null;
  const avatars = useMemo(() => Object.fromEntries(snap?.members.map(x => [x.id, x.avatarUrl]) ?? []), [snap]);
  const postTo: PostTo = cult ? cult.id : 'all';
  const mine = holdings.find(h => h.market.toLowerCase() === id.toLowerCase());
  const longs = markers.filter(x => x.side !== 'short').length;
  const longPct = markers.length ? Math.round((longs / markers.length) * 100) : null;
  const last = candles.at(-1);
  const range = candles.slice(-24);
  const high = range.length ? Math.max(...range.map(c => c.high)) : null;
  const low = range.length ? Math.min(...range.map(c => c.low)) : null;
  const ticket: TicketMarket | null = m ? { venue: m.venue, id: m.id, symbol: m.symbol, maxLeverage: m.maxLeverage, priceUsd: m.priceUsd ?? last?.close ?? null } : null;

  return <div className="view two-col market-view">
    {error && !m ? <section className="view-main"><button className="back" onClick={onBack}><ArrowLeft size={15} /> All markets</button><p className="notice-line">{error}</p></section> : !m || !chartMarket || !ticket ? <section className="view-main"><div className="skel skel-head" /><div className="skel skel-chart" /></section> : <>
      <section className="view-main">
        <section className="card mkt-bar">
          <button className="icon-btn" title="All markets" onClick={onBack}><ArrowLeft size={16} /></button>
          <div className="mkt-bar-id">
            <TokenLogo symbol={m.symbol} imageUri={m.imageUri} />
            <div className="mkt-bar-name"><h1>{m.symbol}</h1><small><span className="venue">{isPerp ? 'Perpl' : 'Nad.fun'}</span>{isPerp ? `Perpetual · ${Math.floor(m.maxLeverage)}x` : m.name}</small></div>
            <span className="mkt-bar-actions">
              <button className={`icon-btn mkt-star${starred ? ' on' : ''}`} aria-pressed={starred} aria-label={starred ? `Remove ${m.symbol} from your watchlist` : `Add ${m.symbol} to your watchlist`} title={starred ? 'On your watchlist' : 'Add to your watchlist'} onClick={() => toggleStar(me.id, m.id)}><Star size={17} fill={starred ? 'currentColor' : 'none'} /></button>
              <PriceAlertControl owner={me.id} marketId={m.id} symbol={m.symbol} current={m.priceUsd ?? last?.close ?? null} />
            </span>
          </div>
          <div className="mkt-bar-price"><strong className={`num ${(m.change24hPct ?? 0) >= 0 ? 'up' : 'down'}`}>{price(m.priceUsd ?? last?.close)}</strong><small>Mark price</small></div>
          <dl className="mkt-stats">
            <div><dt>24H change</dt><dd className={`num ${(m.change24hPct ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(m.change24hPct)}</dd></div>
            <div><dt>24H volume</dt><dd className="num">{compactDollars(m.volume24hUsd)}</dd></div>
            <div><dt>Range high / low</dt><dd className="num">{price(high)} / {price(low)}</dd></div>
            <div><dt>{isPerp ? 'Max leverage' : 'Venue'}</dt><dd>{isPerp ? `${Math.floor(m.maxLeverage)}x` : 'Spot'}</dd></div>
            {cult && <div className="sentiment"><dt>{cult.name} sentiment</dt>{longPct == null ? <dd>No positions</dd> : <dd className="num"><em className="up">{longPct}% long</em> · <em className="down">{100 - longPct}% short</em><i className="sentiment-bar"><i style={{ width: `${longPct}%` }} /></i></dd>}</div>}
          </dl>
        </section>

        <section className="card chart-card">
          <div className="chart-tools">
            <div className="seg seg--sm">{RESOLUTIONS.map(r => <button key={r.seconds} className={resolution === r.seconds ? 'on' : ''} onClick={() => social.onResolution(r.seconds)}>{r.label}</button>)}</div>
            <div className="seg seg--sm" role="radiogroup" aria-label="Chart type">{(['candles', 'line'] as const).map(kind => <button key={kind} role="radio" aria-checked={chartStyle === kind} className={chartStyle === kind ? 'on' : ''} onClick={() => setChartStyle(kind)}>{kind === 'candles' ? 'Candles' : 'Line'}</button>)}</div>
            {cult && <span className={`live ${social.live ? 'on' : ''}`}><i />{social.live ? 'Live' : 'Synced'} · {markers.length}</span>}
          </div>
          <div className="chart-wrap">
            <SharedChart candles={candles} markers={markers} market={chartMarket} selectedId={selected?.id ?? null} onSelect={marker => social.onSelect(marker)} onGuideDrop={social.onGuideDrop} guidesDisabled={!!busy} avatars={avatars} chartStyle={chartStyle} />
            {selected && <MarkerCard marker={selected} symbol={m.symbol} busy={!!busy} now={social.now} avatarUrl={avatarOf(selected.memberId)}
              stackUsd={social.stackUsd} onStackUsd={social.onStackUsd} onStack={social.onStack}
              tpDraft={social.tpDraft} slDraft={social.slDraft} onTpDraft={social.onTpDraft} onSlDraft={social.onSlDraft} onSaveLevels={social.onSaveLevels}
              onApplySuggestion={social.onApplySuggestion} onSkip={social.onSkip} onClosePosition={() => social.onClosePosition(m.id)} onShare={() => social.onShare(selected)} onDismiss={() => social.onSelect(null)} />}
          </div>
          {social.cults.length > 0 && <div className="chart-legend">
            <label className="friends-toggle">
              <input className="switch" type="checkbox" checked={!!cult} onChange={event => social.onCult(event.target.checked ? friendsCult : null)} />
              <span>Friends on chart</span>
            </label>
            {cult && social.cults.length > 1 && <select className="friends-pick" value={cult.id} aria-label="Cult on chart" onChange={event => social.onCult(event.target.value)}>{social.cults.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
            {cult && <><span><i className="lg-own" />Own trade</span><span><i className="lg-auto" />Auto copy</span><span><i className="lg-stack" />Stacked</span><span className="chart-legend-hint">Tap a photo to see their trade</span></>}
          </div>}
        </section>

        <section className="card">
          <div className="tabs">
            <button className={tab === 'cult' ? 'on' : ''} onClick={() => setTab('cult')}>{cult ? `${cult.name} positions` : 'Cult positions'}</button>
            <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My position{mine && <b>1</b>}</button>
            <button className={tab === 'about' ? 'on' : ''} onClick={() => setTab('about')}>About</button>
          </div>
          {tab === 'cult' ? (cult ? markers.length ? <div className="feed">{markers.map(x => <button key={x.id} className={`feed-row ${selected?.id === x.id ? 'on' : ''}`} onClick={() => social.onSelect(x)}>
            <Avatar name={x.memberName} url={avatarOf(x.memberId)} />
            <span className="feed-who"><strong>{x.isMine ? 'You' : x.memberName}</strong><small>{originName(x.origin)} · entry {price(x.entryPrice)}</small></span>
            <span className={`side-chip ${x.side}`}>{x.side.toUpperCase()}{x.leverage ? ` ${x.leverage}x` : ''}</span>
            <b className={`num ${x.venue === 'perpl' ? ((x.pnlUsd ?? 0) >= 0 ? 'up' : 'down') : ''}`}>{x.venue === 'perpl' ? (x.pnlUsd == null ? 'Pending' : signedDollars(x.pnlUsd)) : (x.valueUsd == null ? 'Pending' : dollars(x.valueUsd))}</b>
            {!x.isMine && <span className="feed-copy" role="presentation">Stack</span>}
          </button>)}</div> : <div className="empty"><strong>Nobody in {cult.name} is in {m.symbol} yet.</strong><span>Open one and it shows up here, on everyone&apos;s chart.</span></div>
            : <div className="empty"><strong>{social.cults.length ? 'Friends on chart is off' : 'Trade with friends'}</strong><span>{social.cults.length ? 'Turn it on under the chart to see your friends’ positions here, with their PnL.' : 'Join or create a cult and your friends’ positions show on this chart.'}</span></div>)
          : tab === 'mine' ? (mine ? <div className="my-pos">
            <div className="my-pos-grid">
              <div><span>Side</span><b><span className={`side-chip ${mine.side}`}>{mine.side.toUpperCase()}{mine.venue === 'perpl' ? ` ${mine.leverage}x` : ''}</span></b></div>
              <div><span>Size</span><b className="num">{Number(mine.size.toPrecision(5))}</b></div>
              <div><span>Entry</span><b className="num">{price(mine.entryPriceAusd)}</b></div>
              <div><span>Mark</span><b className="num">{price(mine.markPriceAusd)}</b></div>
              <div><span>Value</span><b className="num">{dollars(mine.valueAusd)}</b></div>
              <div><span>PnL</span><b className={`num ${(mine.pnlAusd ?? 0) >= 0 ? 'up' : 'down'}`}>{mine.pnlAusd == null ? '—' : signedDollars(mine.pnlAusd)}</b></div>
            </div>
            <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => social.onClosePosition(m.id)}>{mine.venue === 'perpl' ? 'Close position' : 'Sell all'}</button>
          </div> : <div className="empty"><span>You have no position on {m.symbol}. Use the ticket to open one.</span></div>)
          : <dl className="about">
            <div><dt>Market</dt><dd>{m.symbol}</dd></div>
            <div><dt>Name</dt><dd>{m.name}</dd></div>
            <div><dt>Venue</dt><dd>{isPerp ? 'Perpl perpetuals on Monad' : 'Nad.fun bonding curve on Monad'}</dd></div>
            <div><dt>Price</dt><dd className="num">{price(m.priceUsd)}</dd></div>
            <div><dt>24H volume</dt><dd className="num">{compactDollars(m.volume24hUsd)}</dd></div>
            {isPerp && <div><dt>Leverage</dt><dd>1x to {Math.floor(m.maxLeverage)}x</dd></div>}
          </dl>}
        </section>
      </section>

      <aside className="view-side">
        <section className="card ticket-card">
          <div className="card-head"><h2>{isPerp ? 'Trade' : 'Buy'} {m.symbol.replace(/-PERP$/, '')}</h2><span className="count num">{price(ticket.priceUsd)}</span></div>
          <TradeTicket market={ticket} balances={me.balances} monPriceUsd={config?.monPriceAusd ?? null}
            cults={social.cults} defaultPostTo={postTo} busy={busy === 'open'} onSubmit={(side, margin, lev, cultIds, tpsl) => onTrade(ticket, side, margin, lev, cultIds, tpsl)} onDeposit={onDeposit} />
        </section>
        {cult && snap && <section className="card">
          <div className="card-head"><h2>{cult.name}</h2></div>
          <div className="mini-members">{snap.members.slice(0, 6).map(member => <button key={member.id} onClick={() => onProfile(member.id)}><Avatar name={member.name} url={member.avatarUrl} /><span><strong>{member.name}</strong><small>{member.winRate == null ? '—' : `${Math.round(member.winRate * 100)}% win`}</small></span><b className={`num ${(member.realizedPnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{member.realizedPnlUsd == null ? '—' : signedDollars(member.realizedPnlUsd)}</b></button>)}</div>
        </section>}
      </aside>
    </>}
  </div>;
}
