'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { ArrowRight, TrendingUp } from 'lucide-react';
import { getHome } from '@/lib/api';
import type { BackendConfig, ChatRoom, Holding, Home, Me, NadMarket } from '@/lib/contracts';
import { dollars, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';

type Props = {
  me: Me; config: BackendConfig | null; holdings: Holding[]; nadMarkets: NadMarket[]; search: string;
  onRoom: (roomId: string) => void; onProfile: (memberId: string) => void;
  onTrade: (trade: Home['topTrades'][number]) => void; onDeposit: () => void;
};

export function RoomRow({ room, onOpen }: { room: ChatRoom; onOpen: () => void }) {
  const last = room.lastMessage;
  return <button className="home-room" onClick={onOpen}>
    <span className={`room-avatar ${room.kind}`}>{room.icon}</span>
    <span className="room-lines"><strong>{room.name}</strong><small>{last?.text ?? 'No messages yet'}</small></span>
    <span className="room-end"><small>{last ? new Date(last.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</small><ArrowRight size={15} /></span>
  </button>;
}

export function HomeView({ me, config, holdings, nadMarkets, search, onRoom, onProfile, onTrade, onDeposit }: Props) {
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const trending = [
    ...(config?.markets ?? []).filter(market => /^(BTC|ETH|SOL|MON)/i.test(market.symbol)).slice(0, 4),
    ...nadMarkets.slice(0, 4),
  ].filter(market => market.symbol.toLowerCase().includes(query)).slice(0, 8);
  const cash = me.balances?.walletUsd ?? null;
  const margin = me.balances?.perplMarginUsd ?? null;
  const spotValue = holdings.filter(item => item.venue === 'nadfun').reduce((sum, item) => sum + item.valueAusd, 0);
  const total = cash == null ? null : cash + (margin ?? 0) + spotValue;

  return <main className="home-layout">
    <div className="home-main">
      <div className="home-intro"><span className="eyebrow">HOME</span><h1>Good to see you, {me.name}.</h1></div>
      <section className="home-section"><div className="home-section-head"><h2>Top trades this week</h2><span>7 DAYS</span></div>
        {error ? <p className="wallet-warning">{error}</p> : !home ? <p className="field-note">Loading weekly trades...</p> : home.topTrades.length ? <div className="trade-carousel">{home.topTrades.map(trade => <article className="top-trade" key={`${trade.memberId}:${trade.rank}`}>
          <button className="top-trade-person" onClick={() => onProfile(trade.memberId)}><Avatar name={trade.name} url={trade.avatarUrl} /><span><strong>{trade.name}</strong><small>#{trade.rank} Trade</small></span></button>
          <strong className={`trade-return ${trade.returnPct >= 0 ? 'positive' : 'negative'}`}>{trade.returnPct >= 0 ? '+' : ''}{trade.returnPct.toFixed(1)}%</strong>
          <div className="trade-card-bottom"><span className="symbol-chip">{trade.symbol}</span><small>{trade.tradersIn} {trade.tradersIn === 1 ? 'trader was' : 'traders were'} in</small></div>
          <button className="trade-card-link" onClick={() => onTrade(trade)}>View trade <ArrowRight size={14} /></button>
        </article>)}</div> : <p className="field-note">No verified closed trades this week yet.</p>}
        {home && <p className="week-line">7d: <strong>{home.sevenDay.trades} trades</strong><span>·</span><strong className={home.sevenDay.profitUsd >= 0 ? 'positive' : 'negative'}>{signedDollars(home.sevenDay.profitUsd)} profit made</strong><span>·</span><strong>{home.sevenDay.positionsOpened} positions opened</strong></p>}
      </section>
      <section className="home-section"><div className="home-section-head"><h2>My Groups</h2><span>{rooms.length}</span></div><div className="home-rooms">{rooms.length ? rooms.map(room => <RoomRow key={room.id} room={room} onOpen={() => onRoom(room.id)} />) : <p className="field-note">No groups match your search.</p>}</div></section>
    </div>
    <aside className="home-right">
      <section className="home-card"><span className="eyebrow">PORTFOLIO</span><div className="portfolio-total">{dollars(total)}</div><div className="portfolio-lines"><div><span>Wallet cash</span><strong>{dollars(cash)}</strong></div><div><span>Perpl margin</span><strong>{dollars(margin)}</strong></div><div><span>Spot holdings</span><strong>{dollars(spotValue)}</strong></div></div><button className="primary full" onClick={onDeposit}>Deposit</button></section>
      <section className="home-card"><span className="eyebrow">ACTIVE POSITIONS</span>{holdings.length ? holdings.slice(0, 4).map(item => <div className="home-holding" key={`${item.venue}:${item.market}`}><div><strong>{item.symbol}</strong><small>{item.side.toUpperCase()} · {item.venue === 'perpl' ? 'Perpl' : 'Nad.fun'}</small></div><span className={(item.pnlAusd ?? 0) >= 0 ? 'positive' : 'negative'}>{item.pnlAusd == null ? 'Pending' : signedDollars(item.pnlAusd)}</span></div>) : <p className="field-note">No open positions.</p>}</section>
      <section className="home-card"><span className="eyebrow">TRENDING MARKETS</span>{trending.length ? trending.map(item => <div className="trending-row" key={`${item.venue}:${item.id}`}><TrendingUp size={15} /><strong>{item.symbol}</strong><small>{item.venue === 'perpl' ? 'Perpl' : 'Nad.fun'}</small></div>) : <p className="field-note">No markets match your search.</p>}</section>
    </aside>
  </main>;
}
