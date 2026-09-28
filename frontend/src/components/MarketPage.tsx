'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, TrendingDown, TrendingUp, UsersRound } from 'lucide-react';
import { getMarket } from '@/lib/api';
import { cachedMarket } from '@/lib/marketCache';
import type { BackendConfig, ChartMarker, ChartSnapshot, Clan, Market, MarketDetail, Me, TpslSuggestion } from '@/lib/contracts';
import { dollars, signedDollars } from '@/lib/format';
import { SharedChart } from './SharedChart';
import { TokenLogo } from './TokenLogo';
import { Avatar } from './Avatar';
import { MarkerCard } from './MarkerCard';
import { TradeTicket, type PostTo, type TicketMarket } from './TradeTicket';
import { RoomBadge } from './RoomBadge';

// A market is also its cult's chart: pick one of your cults and every
// cult-mate's position on this market is drawn on it, with name and live PnL.
// Tap one to stack on it or suggest TP/SL; drag your own lines to set real
// orders. "Just me" is the plain chart.

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
  onBack: () => void;
  onTrade: (market: TicketMarket, side: 'long' | 'short' | 'buy', marginUsd: number, leverage: number | undefined, cultIds: string[] | undefined) => void;
  onDeposit: () => void;
};

const RESOLUTIONS = [{ label: '5m', seconds: 300 }, { label: '1h', seconds: 3600 }, { label: '1D', seconds: 86400 }];
const price = (v: number | null | undefined) => v == null ? '—' : v >= 1 ? dollars(v) : `$${v.toPrecision(3)}`;

export function MarketPage({ id, me, config, busy, social, onBack, onTrade, onDeposit }: Props) {
  const resolution = social.resolution;
  const [detail, setDetail] = useState<MarketDetail | null>(() => cachedMarket(id, resolution));
  const [error, setError] = useState<string | null>(null);
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
  const postTo: PostTo = cult ? cult.id : 'all';

  return <main className="full-workspace market-page social-market">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> All markets</button>
    {error && !m ? <p className="wallet-warning">{error}</p> : !m || !chartMarket ? <div className="market-skeleton"><div className="skeleton-line wide" /><div className="skeleton-card tall" /></div> : <div className="market-page-grid">
      <section className="market-page-main">
        <div className="market-page-head">
          <TokenLogo symbol={m.symbol} imageUri={m.imageUri} className="market-icon" />
          <div><h1>{m.symbol}</h1><small>{isPerp ? `Perpetual · up to ${m.maxLeverage}x` : m.name}</small></div>
          <div className="market-page-price"><strong>{price(m.priceUsd)}</strong>{m.change24hPct != null && <small className={`market-change ${m.change24hPct >= 0 ? 'positive' : 'negative'}`}>{m.change24hPct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{m.change24hPct >= 0 ? '+' : ''}{m.change24hPct.toFixed(2)}%</small>}</div>
        </div>

        {social.cults.length > 0 && <div className="cult-switch" role="tablist" aria-label="Friends on chart">
          <span className="cult-switch-label"><UsersRound size={14} /> Friends on chart</span>
          {social.cults.map(c => <button key={c.id} role="tab" aria-selected={social.cultId === c.id} className={social.cultId === c.id ? 'active' : ''} onClick={() => social.onCult(c.id)}><RoomBadge icon={c.name.trim()[0]?.toUpperCase() ?? 'C'} kind="cult" size="sm" />{c.name}</button>)}
          <button role="tab" aria-selected={!social.cultId} className={!social.cultId ? 'active' : ''} onClick={() => social.onCult(null)}>Off</button>
        </div>}

        <div className="chart-toolbar">
          <div className="markets-tabs small">{RESOLUTIONS.map(r => <button key={r.seconds} className={resolution === r.seconds ? 'active' : ''} onClick={() => social.onResolution(r.seconds)}>{r.label}</button>)}</div>
          {cult && <span className={`live-dot ${social.live ? 'on' : ''}`}>{social.live ? 'LIVE' : 'UPDATING'} · {markers.length} {markers.length === 1 ? 'position' : 'positions'}</span>}
        </div>
        <div className="market-chart social">
          <SharedChart candles={candles} markers={markers} market={chartMarket} selectedId={selected?.id ?? null} onSelect={marker => social.onSelect(marker)} onGuideDrop={social.onGuideDrop} guidesDisabled={!!busy} />
          {selected && <MarkerCard marker={selected} symbol={m.symbol} busy={!!busy} now={social.now} avatarUrl={avatarOf(selected.memberId)}
            stackUsd={social.stackUsd} onStackUsd={social.onStackUsd} onStack={social.onStack}
            tpDraft={social.tpDraft} slDraft={social.slDraft} onTpDraft={social.onTpDraft} onSlDraft={social.onSlDraft} onSaveLevels={social.onSaveLevels}
            onApplySuggestion={social.onApplySuggestion} onSkip={social.onSkip} onClosePosition={() => social.onClosePosition(m.id)} onShare={() => social.onShare(selected)} onDismiss={() => social.onSelect(null)} />}
        </div>

        {cult ? <section className="on-chart">
          <div className="on-chart-head"><h2>{cult.name} on {m.symbol}</h2><small>Tap a position to stack on it or suggest TP/SL</small></div>
          {markers.length ? <div className="on-chart-list">{markers.map(x => <button key={x.id} className={selected?.id === x.id ? 'active' : ''} onClick={() => social.onSelect(x)}>
            <Avatar name={x.memberName} url={avatarOf(x.memberId)} />
            <span className="on-chart-who"><strong>{x.isMine ? 'You' : x.memberName}</strong><small>{x.origin === 'auto_mirror' ? 'Auto copy' : x.origin === 'manual_stack' ? 'Stacked' : 'Own trade'} · {x.side.toUpperCase()}{x.leverage ? ` ${x.leverage}x` : ''}</small></span>
            <b className={x.venue === 'perpl' ? ((x.pnlUsd ?? 0) >= 0 ? 'positive' : 'negative') : ''}>{x.venue === 'perpl' ? (x.pnlUsd == null ? 'Pending' : signedDollars(x.pnlUsd)) : (x.valueUsd == null ? 'Pending' : dollars(x.valueUsd))}</b>
          </button>)}</div> : <p className="field-note">Nobody in {cult.name} has a position on {m.symbol} yet. Open one and it shows here for them.</p>}
        </section> : social.cults.length ? <p className="field-note on-chart-hint">Pick a cult above to see your friends&apos; positions on this chart.</p> : <p className="field-note on-chart-hint">Join or create a cult and your friends&apos; positions show up on this chart, with their PnL.</p>}
        {m.volume24hUsd != null && <p className="field-note">24h volume {dollars(m.volume24hUsd, 0)}</p>}
      </section>
      <aside className="market-ticket">
        <TradeTicket market={{ venue: m.venue, id: m.id, symbol: m.symbol, maxLeverage: m.maxLeverage, priceUsd: m.priceUsd }} balances={me.balances} monPriceUsd={config?.monPriceAusd ?? null}
          cults={social.cults} defaultPostTo={postTo} busy={busy === 'open'} onSubmit={(side, margin, lev, cultIds) => onTrade({ venue: m.venue, id: m.id, symbol: m.symbol, maxLeverage: m.maxLeverage, priceUsd: m.priceUsd }, side, margin, lev, cultIds)} onDeposit={onDeposit} />
      </aside>
    </div>}
  </main>;
}
