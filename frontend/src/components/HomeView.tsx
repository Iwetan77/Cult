'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getAccessToken } from '@/lib/auth';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Compass, Plus, Trophy, Wallet } from './icons';
import { HotPill, isHotMarket } from './HotPill';
import { getHome, getMarkets, getProfile } from '@/lib/api';
import { cachedList } from '@/lib/marketCache';
import type { ChatRoom, ClosedTrade, Holding, Home, MarketListing, Me } from '@/lib/contracts';
import { compactDollars, dollars, price, signedDollars, signedPct, timeAgo } from '@/lib/format';
import { Avatar } from './Avatar';
import { TokenLogo } from './TokenLogo';
import { RoomBadge } from './RoomBadge';

type Props = {
  me: Me; holdings: Holding[]; unread: Record<string, number>; mentioned: Record<string, boolean>; search: string; onMarket: (id: string) => void;
  onRoom: (roomId: string) => void; onProfile: (memberId: string) => void;
  onTrade: (trade: Home['topTrades'][number]) => void; onDeposit: () => void;
  onCreate: () => void; onDiscover: () => void;
};

// Rooms with the newest message first: a new message moves its cult to the top.
const lastAt = (room: ChatRoom) => room.lastMessage ? Date.parse(room.lastMessage.createdAt) : 0;
export const latestFirst = (rooms: ChatRoom[]) => [...rooms].sort((a, b) => lastAt(b) - lastAt(a));

// Unread messages, as a bubble on a room's badge.
// White with the count; peach "@" when someone mentioned you there.
export const UnreadBubble = ({ count, mention }: { count?: number; mention?: boolean }) => mention ? <b className="unread-bubble mention" aria-label="You were mentioned">@</b>
  : count ? <b className="unread-bubble" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</b> : null;

export function RoomRow({ room, unread, mention, onOpen }: { room: ChatRoom; unread?: number; mention?: boolean; onOpen: () => void }) {
  const last = room.lastMessage;
  return <button className={`room-row${unread ? ' is-unread' : ''}`} onClick={onOpen}>
    <span className="badge-wrap"><RoomBadge icon={room.icon} kind={room.kind} size="lg" /><UnreadBubble count={unread} mention={mention} /></span>
    <span className="room-row-lines"><strong>{room.name}</strong><small>{last ? (last.kind === 'system' ? last.text : `${last.memberName}: ${last.body}`) : 'No messages yet'}</small></span>
    <span className="room-row-meta"><small>{room.memberCount} {room.memberCount === 1 ? 'member' : 'members'}</small>{last && <time>{timeAgo(Date.parse(last.createdAt))}</time>}</span>
    <ArrowRight size={16} className="room-row-go" />
  </button>;
}

const DAY = 86_400_000;

// Realized PnL over the last 30 days, as a running total: one point per close.
// The backend keeps no history of the account's value, so this is the honest
// line we can draw.
function RealizedLine({ closed }: { closed: ClosedTrade[] }) {
  const now = Date.now();
  const start = now - 30 * DAY;
  const recent = closed.filter(t => t.closedAt >= start && t.pnlUsd != null).sort((a, b) => a.closedAt - b.closedAt);
  let running = 0;
  const points = [{ t: start, v: 0 }, ...recent.map(t => ({ t: t.closedAt, v: (running += t.pnlUsd ?? 0) })), { t: now, v: running }];
  const lo = Math.min(0, ...points.map(p => p.v)), hi = Math.max(0, ...points.map(p => p.v));
  const span = hi - lo || 1;
  const x = (t: number) => ((t - start) / (now - start)) * 300;
  const y = (v: number) => 4 + (1 - (v - lo) / span) * 48;
  // A step line: the total only moves when a trade closes.
  const path = points.map((p, i) => i === 0 ? `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}` : `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}`).join('');
  return <div className="portfolio-line">
    <div className="portfolio-line-head"><span>Realized, 30 days</span><b className={`num ${running >= 0 ? 'up' : 'down'}`}>{recent.length ? signedDollars(running) : '—'}</b></div>
    <svg viewBox="0 0 300 56" preserveAspectRatio="none" role="img" aria-label={recent.length ? `Realized PnL over 30 days: ${signedDollars(running)} from ${recent.length} closed trades` : 'No closed trades in the last 30 days'}>
      <line x1="0" x2="300" y1={y(0)} y2={y(0)} className="portfolio-line-zero" />
      <path d={path} className={running >= 0 ? 'is-up' : 'is-down'} />
    </svg>
    {!recent.length && <small className="portfolio-line-empty">No closed trades in the last 30 days.</small>}
  </div>;
}

// The money side: one total, what it's made of, how closed trades have gone,
// and a way to add more.
export function PortfolioCard({ me, holdings, closed, onDeposit }: { me: Me; holdings: Holding[]; closed: ClosedTrade[] | null; onDeposit: () => void }) {
  // Dollars: AUSD plus deposited USDC (turned into AUSD by itself).
  const cash = me.balances ? me.balances.walletUsd + (me.balances.usdcUsd ?? 0) : null;
  const margin = me.balances?.perplMarginUsd ?? 0;
  const predictions = me.balances?.predictionsUsd ?? 0;
  const mon = me.balances?.monUsd ?? 0;
  const memes = holdings.filter(item => item.venue === 'nadfun').reduce((sum, item) => sum + item.valueAusd, 0);
  const openPnl = holdings.filter(item => item.venue === 'perpl').reduce((sum, item) => sum + (item.pnlAusd ?? 0), 0);
  const total = cash == null ? null : cash + margin + predictions + mon + memes;
  const parts = [{ label: 'Dollars', value: cash ?? 0, tone: 'a' }, { label: 'MON', value: mon, tone: 'b' }, { label: 'Perps margin', value: margin, tone: 'c' }, { label: 'Memes', value: memes, tone: 'd' }, ...(predictions > 0 ? [{ label: 'Predictions', value: predictions, tone: 'e' }] : [])];
  const sum = parts.reduce((s, p) => s + p.value, 0) || 1;
  return <section className="card portfolio">
    <div className="card-head"><h2>Portfolio</h2>{holdings.length > 0 && <span className={`portfolio-pnl num ${openPnl >= 0 ? 'up' : 'down'}`}>{signedDollars(openPnl)} open</span>}</div>
    <strong className="portfolio-total num">{dollars(total)}</strong>
    <div className="portfolio-bar" aria-hidden="true">{parts.map(p => <i key={p.label} className={`tone-${p.tone}`} style={{ width: `${(p.value / sum) * 100}%` }} />)}</div>
    <dl className="portfolio-lines">{parts.map(p => <div key={p.label}><dt><i className={`tone-${p.tone}`} />{p.label}</dt><dd className="num">{dollars(p.value)}</dd></div>)}</dl>
    {closed && <RealizedLine closed={closed} />}
    <button className="btn btn-primary btn-block" onClick={onDeposit}><Wallet size={16} /> Deposit</button>
  </section>;
}

export function PositionsCard({ holdings, onMarket, title = 'Open positions' }: { holdings: Holding[]; onMarket: (id: string) => void; title?: string }) {
  return <section className="card">
    <div className="card-head"><h2>{title}</h2></div>
    {holdings.length ? <div className="pos-list">{holdings.slice(0, 8).map(item => <button className="pos-row" key={`${item.venue}:${item.market}`} onClick={() => onMarket(item.market)}>
      <TokenLogo symbol={item.symbol} />
      <span className="pos-name"><strong>{item.symbol}</strong><small><span className={`side-chip ${item.side}`}>{item.side.toUpperCase()}{item.venue === 'perpl' && item.leverage ? ` ${item.leverage}x` : ''}</span> {dollars(item.valueAusd)}</small></span>
      <span className="pos-pnl num"><b className={item.venue === 'perpl' ? ((item.pnlAusd ?? 0) >= 0 ? 'up' : 'down') : ''}>{item.venue === 'perpl' ? (item.pnlAusd == null ? 'Pending' : signedDollars(item.pnlAusd)) : dollars(item.valueAusd)}</b>{item.venue === 'perpl' && item.entryPriceAusd != null && item.pnlAusd != null && <small className={(item.pnlAusd ?? 0) >= 0 ? 'up' : 'down'}>{signedPct(((item.pnlAusd) / Math.max(1e-9, item.valueAusd - item.pnlAusd)) * 100, 1)}</small>}</span>
    </button>)}</div> : <div className="empty compact"><span>No open positions yet.</span><button className="link" onClick={() => onMarket('')}>Find a market <ArrowRight size={13} /></button></div>}
  </section>;
}

function MarketCard({ m, onOpen }: { m: MarketListing; onOpen: () => void }) {
  return <button className="mkt-card" onClick={onOpen}>
    <span className="mkt-card-top"><TokenLogo symbol={m.symbol} imageUri={m.imageUri} /><span><strong>{m.symbol.replace(/-PERP$/, '')}</strong><small>{m.venue === 'perpl' ? `Perp · ${Math.floor(m.maxLeverage)}x` : 'Meme'}</small></span>{isHotMarket(m.change24hPct) && <HotPill />}</span>
    <span className="mkt-card-price num">{price(m.priceUsd)}</span>
    <span className="mkt-card-foot"><b className={`num ${(m.change24hPct ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(m.change24hPct)}</b><small className="num">{compactDollars(m.volume24hUsd)} vol</small></span>
  </button>;
}

// A new account's first steps, until all three are done.
function FirstSteps({ funded, inCult, traded, onDeposit, onDiscover, onMarket }: { funded: boolean; inCult: boolean; traded: boolean; onDeposit: () => void; onDiscover: () => void; onMarket: (id: string) => void }) {
  const steps = [
    { done: funded, title: 'Add funds', body: 'Deposit USDC, AUSD or MON to your Cult wallet.', action: <button className="btn btn-primary btn-sm" onClick={onDeposit}><Plus size={14} /> Deposit</button> },
    { done: inCult, title: 'Join a cult', body: 'Everyone in it trades on one shared chart.', action: <button className="btn btn-ghost btn-sm" onClick={onDiscover}><Compass size={14} /> Find one</button> },
    { done: traded, title: 'Make your first trade', body: 'Pick a market, go long or short, and your cult sees it.', action: <button className="btn btn-ghost btn-sm" onClick={() => onMarket('')}>Browse markets <ArrowRight size={14} /></button> },
  ];
  const next = steps.findIndex(s => !s.done);
  return <section className="card first-steps reveal">
    <div className="card-head"><h2>Get started</h2></div>
    <ol className="first-steps-list">{steps.map((step, i) => <li key={step.title} className={step.done ? 'is-done' : i === next ? 'is-next' : ''}>
      <span className="first-steps-mark" aria-hidden="true">{step.done ? <Check size={14} /> : i + 1}</span>
      <span className="first-steps-lines"><strong>{step.title}</strong><small>{step.done ? 'Done' : step.body}</small></span>
      {!step.done && i === next && step.action}
    </li>)}</ol>
  </section>;
}

const pickTrending = (list: MarketListing[]) => {
  const perps = list.filter(m => m.venue === 'perpl').sort((a, b) => Math.abs(b.change24hPct ?? 0) * Math.log10((b.volume24hUsd ?? 1) + 10) - Math.abs(a.change24hPct ?? 0) * Math.log10((a.volume24hUsd ?? 1) + 10));
  const memes = list.filter(m => m.venue === 'nadfun').sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  return [...perps.slice(0, 5), ...memes.slice(0, 3)];
};

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

export function HomeView({ me, holdings, unread, mentioned, search, onMarket, onRoom, onProfile, onTrade, onDeposit, onCreate, onDiscover }: Props) {
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markets, setMarkets] = useState<MarketListing[]>(() => cachedList('') ?? []);
  // Your closed trades: the realized line, and whether you've traded yet.
  const [closed, setClosed] = useState<ClosedTrade[] | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    getMarkets().then(r => { if (active) setMarkets(r.markets); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to load Home.');
      void getProfile(token, 'me').then(p => { if (active) setClosed(p.closedTrades); }).catch(() => { if (active) setClosed([]); });
      return getHome(token);
    }).then(value => { if (active) setHome(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Home is unavailable.'); });
    return () => { active = false; };
  }, []);
  const scroll = (dir: number) => rail.current?.scrollBy({ left: dir * (rail.current.clientWidth * 0.8), behavior: 'smooth' });
  const query = search.trim().toLowerCase();
  const cults = latestFirst(me.rooms.filter(room => room.kind === 'cult' && room.name.toLowerCase().includes(query)));
  const trending = useMemo(() => pickTrending(markets), [markets]);

  const wallet = me.balances ? me.balances.walletUsd + (me.balances.usdcUsd ?? 0) + (me.balances.perplMarginUsd ?? 0) : null;
  const funded = (wallet ?? 0) + (me.balances?.monUsd ?? 0) > 0 || holdings.length > 0;
  const inCult = me.clans.length > 0;
  const traded = holdings.length > 0 || (closed?.length ?? 0) > 0;
  const newcomer = closed !== null && !(funded && inCult && traded);

  return <div className="view two-col">
    <section className="view-main">
      <header className="page-head">
        <div><span className="eyebrow">{greeting()}</span><h1 className="display">{me.name}</h1></div>
        <div className="page-actions"><button className="btn btn-ghost btn-sm" onClick={onDiscover}><Compass size={14} /> Discover cults</button><button className="btn btn-primary btn-sm" onClick={onCreate}><Plus size={14} /> Create a cult</button></div>
      </header>

      {newcomer && <FirstSteps funded={funded} inCult={inCult} traded={traded} onDeposit={onDeposit} onDiscover={onDiscover} onMarket={onMarket} />}

      <section className="block reveal" style={{ '--d': '80ms' } as React.CSSProperties}>
        <div className="block-head"><h2><Trophy size={18} /> Top trades this week</h2><div className="block-tools"><button className="icon-btn" title="Previous" onClick={() => scroll(-1)}><ChevronLeft size={17} /></button><button className="icon-btn" title="Next" onClick={() => scroll(1)}><ChevronRight size={17} /></button></div></div>
        {error ? <p className="notice-line">{error}</p> : <div className="carousel" ref={rail}>
          {!home ? Array.from({ length: 4 }, (_, i) => <div key={i} className="trade-card skel" />) : home.topTrades.length ? home.topTrades.map(trade => <article className={`trade-card ${trade.rank === 1 ? 'is-first' : ''}`} key={`${trade.memberId}:${trade.rank}`}>
            <div className="trade-card-top"><span className="trade-card-rank">#{trade.rank} Trade</span><span className={`side-chip ${trade.side}`}>{trade.side.toUpperCase()}</span></div>
            <button className="trade-card-who" onClick={() => onProfile(trade.memberId)}><Avatar name={trade.name} url={trade.avatarUrl} /><span>{trade.name}</span></button>
            <strong className={`trade-card-return num ${trade.returnPct >= 0 ? 'up' : 'down'}`}>{trade.returnPct >= 0 ? '+' : ''}{trade.returnPct.toFixed(1)}%</strong>
            <div className="trade-card-market"><TokenLogo symbol={trade.symbol} /><b>{trade.symbol}</b><small className="num">{trade.pnlUsd == null ? 'verifying' : signedDollars(trade.pnlUsd)}</small></div>
            <div className="trade-card-foot"><small>{trade.tradersIn} {trade.tradersIn === 1 ? 'trader was' : 'traders were'} in</small><button className="link" onClick={() => onTrade(trade)}>View trade <ArrowRight size={13} /></button></div>
          </article>) : <div className="empty"><strong>Quiet week.</strong><span>The best trades across Cult show up here as they close.</span></div>}
        </div>}
      </section>

      <section className="block reveal" style={{ '--d': '140ms' } as React.CSSProperties}>
        <div className="block-head"><h2>Trending markets</h2><button className="link" onClick={() => onMarket('')}>All markets <ArrowRight size={13} /></button></div>
        <div className="mkt-grid">{trending.length ? trending.map(m => <MarketCard key={`${m.venue}:${m.id}`} m={m} onOpen={() => onMarket(m.id)} />) : Array.from({ length: 8 }, (_, i) => <span key={i} className="mkt-card skel" />)}</div>
      </section>

      <section className="block reveal" style={{ '--d': '200ms' } as React.CSSProperties}>
        <div className="block-head"><h2>My cults</h2></div>
        <div className="card flush">{cults.length ? cults.map(room => <RoomRow key={room.id} room={room} unread={unread[room.id]} mention={mentioned[room.id]} onOpen={() => onRoom(room.id)} />) : <div className="empty"><strong>{query ? 'No cults match your search.' : 'You are not in a cult yet.'}</strong>{!query && <span>Trade together: everyone&apos;s positions show on one chart.</span>}{!query && <div className="empty-actions"><button className="btn btn-primary btn-sm" onClick={onCreate}>Create a cult</button><button className="btn btn-ghost btn-sm" onClick={onDiscover}>Find one</button></div>}</div>}</div>
      </section>
    </section>

    <aside className="view-side">
      <PortfolioCard me={me} holdings={holdings} closed={closed} onDeposit={onDeposit} />
      <PositionsCard holdings={holdings} onMarket={onMarket} />
    </aside>
  </div>;
}
