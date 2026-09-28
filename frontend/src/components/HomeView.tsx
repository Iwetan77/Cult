'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { ArrowRight, Wallet } from 'lucide-react';
import { getHome, getMarkets } from '@/lib/api';
import { cachedList } from '@/lib/marketCache';
import type { ChatRoom, Holding, Home, MarketListing, Me } from '@/lib/contracts';
import { dollars, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';
import { TokenLogo } from './TokenLogo';
import { RoomBadge } from './RoomBadge';

type Props = {
  me: Me; holdings: Holding[]; search: string; onMarket: (id: string) => void;
  onRoom: (roomId: string) => void; onProfile: (memberId: string) => void;
  onTrade: (trade: Home['topTrades'][number]) => void; onDeposit: () => void;
};

const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export function RoomRow({ room, onOpen }: { room: ChatRoom; onOpen: () => void }) {
  const last = room.lastMessage;
  return <button className="home-room" onClick={onOpen}>
    <RoomBadge icon={room.icon} kind={room.kind} />
    <span className="room-lines"><strong>{room.name}</strong><small>{last ? (last.kind === 'system' ? last.text : `${last.memberName}: ${last.body}`) : 'No messages yet'}</small></span>
    <span className="room-end"><small>{last ? when(last.createdAt) : `${room.memberCount} ${room.memberCount === 1 ? 'member' : 'members'}`}</small><ArrowRight size={15} /></span>
  </button>;
}

// Trending: the busiest perps and the top memes.
const pickTrending = (list: MarketListing[]) => {
  const perps = list.filter(m => m.venue === 'perpl').sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  const memes = list.filter(m => m.venue === 'nadfun');
  return [...perps.slice(0, 6), ...memes.slice(0, 6)];
};

export function HomeView({ me, holdings, search, onMarket, onRoom, onProfile, onTrade, onDeposit }: Props) {
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trending, setTrending] = useState<MarketListing[]>(() => pickTrending(cachedList('') ?? []));
  useEffect(() => {
    let active = true;
    getMarkets().then(r => { if (active) setTrending(pickTrending(r.markets)); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to load Home.');
      return getHome(token);
    }).then(value => { if (active) setHome(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Home is unavailable.'); });
    return () => { active = false; };
  }, []);

  const query = search.trim().toLowerCase();
  const rooms = me.rooms.filter(room => room.name.toLowerCase().includes(query));
  const cash = me.balances?.walletUsd ?? null;
  const margin = me.balances?.perplMarginUsd ?? null;
  const mon = me.balances?.monUsd ?? null;
  const spotValue = holdings.filter(item => item.venue === 'nadfun').reduce((sum, item) => sum + item.valueAusd, 0);
  const total = cash == null ? null : cash + (margin ?? 0) + (mon ?? 0) + spotValue;

  return <main className="home-layout home-v2">
    <div className="home-main">
      <div className="home-intro"><span className="eyebrow">HOME</span><h1>Good to see you, {me.name}.</h1></div>

      <section className="home-panel">
        <div className="home-panel-head"><h2>Trending</h2><button className="text-link" onClick={() => onMarket('')}>All markets <ArrowRight size={13} /></button></div>
        {trending.length ? <div className="trend-strip">{trending.map(item => <button key={`${item.venue}:${item.id}`} className="trend-chip" onClick={() => onMarket(item.id)}>
          <TokenLogo symbol={item.symbol} imageUri={item.imageUri} />
          <span><strong>{item.symbol}</strong><small className={item.change24hPct == null ? '' : item.change24hPct >= 0 ? 'positive' : 'negative'}>{item.change24hPct == null ? (item.venue === 'nadfun' ? 'Meme' : '—') : `${item.change24hPct >= 0 ? '+' : ''}${item.change24hPct.toFixed(1)}%`}</small></span>
        </button>)}</div> : <div className="trend-strip">{Array.from({ length: 6 }, (_, i) => <span key={i} className="trend-chip skeleton-chip" />)}</div>}
      </section>

      <section className="home-panel">
        <div className="home-panel-head"><h2>Top trades this week</h2>{home && <span className="home-panel-meta">{home.sevenDay.trades} trades · <b className={home.sevenDay.profitUsd >= 0 ? 'positive' : 'negative'}>{signedDollars(home.sevenDay.profitUsd)}</b> · {home.sevenDay.positionsOpened} opened</span>}</div>
        {error ? <p className="wallet-warning">{error}</p> : !home ? <div className="top-trades">{Array.from({ length: 3 }, (_, i) => <div key={i} className="top-trade-card skeleton-card" />)}</div> : home.topTrades.length ? <div className="top-trades">{home.topTrades.map(trade => <article className="top-trade-card" key={`${trade.memberId}:${trade.rank}`}>
          <div className="top-trade-market"><TokenLogo symbol={trade.symbol} /><span><strong>{trade.symbol}</strong><small className={`side-chip ${trade.side}`}>{trade.side.toUpperCase()}</small></span><b className="top-trade-rank">#{trade.rank}</b></div>
          <strong className={`top-trade-return ${trade.returnPct >= 0 ? 'positive' : 'negative'}`}>{trade.returnPct >= 0 ? '+' : ''}{trade.returnPct.toFixed(1)}%</strong>
          <small className="top-trade-pnl">{trade.pnlUsd == null ? 'PnL verifying' : signedDollars(trade.pnlUsd)} · {trade.tradersIn} {trade.tradersIn === 1 ? 'trader' : 'traders'} in</small>
          <div className="top-trade-foot"><button className="top-trade-person" onClick={() => onProfile(trade.memberId)}><Avatar name={trade.name} url={trade.avatarUrl} /><span>{trade.name}</span></button><button className="text-link" onClick={() => onTrade(trade)}>View trade <ArrowRight size={13} /></button></div>
        </article>)}</div> : <div className="home-empty"><strong>Quiet week.</strong><span>The best trades across Cult show up here as they close.</span></div>}
      </section>

      <section className="home-panel">
        <div className="home-panel-head"><h2>My groups</h2><span className="home-panel-meta">{rooms.length}</span></div>
        <div className="home-rooms">{rooms.length ? rooms.map(room => <RoomRow key={room.id} room={room} onOpen={() => onRoom(room.id)} />) : <p className="field-note">No groups match your search.</p>}</div>
      </section>
    </div>

    <aside className="home-right">
      <section className="home-panel portfolio-panel">
        <span className="eyebrow">PORTFOLIO</span>
        <div className="portfolio-total">{dollars(total)}</div>
        <div className="portfolio-lines">
          <div><span>Dollars (AUSD)</span><strong>{dollars(cash)}</strong></div>
          <div><span>MON</span><strong>{dollars(mon)}</strong></div>
          <div><span>Perps margin</span><strong>{dollars(margin)}</strong></div>
          <div><span>Meme holdings</span><strong>{dollars(spotValue)}</strong></div>
        </div>
        <button className="primary full" onClick={onDeposit}><Wallet size={15} /> Deposit</button>
      </section>
      <section className="home-panel">
        <div className="home-panel-head"><h2>Open positions</h2><span className="home-panel-meta">{holdings.length}</span></div>
        {holdings.length ? <div className="home-holdings">{holdings.slice(0, 6).map(item => <button className="home-holding" key={`${item.venue}:${item.market}`} onClick={() => onMarket(item.market)}>
          <span className="holding-identity"><TokenLogo symbol={item.symbol} /><span><strong>{item.symbol}</strong><small>{item.side.toUpperCase()}{item.venue === 'perpl' && item.leverage ? ` ${item.leverage}x` : ''} · {item.venue === 'perpl' ? 'Perp' : 'Meme'}</small></span></span>
          <b className={item.venue === 'perpl' ? ((item.pnlAusd ?? 0) >= 0 ? 'positive' : 'negative') : ''}>{item.venue === 'perpl' ? (item.pnlAusd == null ? 'Pending' : signedDollars(item.pnlAusd)) : dollars(item.valueAusd)}</b>
        </button>)}</div> : <div className="home-empty compact"><span>No open positions.</span><button className="text-link" onClick={() => onMarket('')}>Find a market <ArrowRight size={13} /></button></div>}
      </section>
    </aside>
  </main>;
}
