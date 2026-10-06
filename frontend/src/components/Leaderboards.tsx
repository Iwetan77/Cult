'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@/lib/auth';
import { Crown } from './icons';
import { getCultStandings, getLeaderboard } from '@/lib/api';
import type { CultStanding, Leaderboard, LeaderboardEntry } from '@/lib/contracts';
import { percent, shortAddress, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';
import { RoomBadge } from './RoomBadge';

type Tab = 'global' | 'country' | 'cult' | 'cults';
type Props = { country: { code: string; name: string } | null; cultId: string | null; embedded?: boolean; onProfile?: (memberId: string) => void };

export function Leaderboards({ country, cultId, embedded = false, onProfile }: Props) {
  const [tab, setTab] = useState<Tab>('global');
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [cults, setCults] = useState<CultStanding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tab === 'country' && !country || tab === 'cult' && !cultId) {
      setLoading(false);
      setBoard(null);
      setCults([]);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Sign in again to view rankings.');
        if (tab === 'cults') {
          const result = await getCultStandings(token);
          if (active) { setCults(result.entries); setBoard(null); }
        } else {
          const result = await getLeaderboard(token, tab, cultId ?? undefined);
          if (active) { setBoard(result); setCults([]); }
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Rankings are unavailable.');
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [tab, country, cultId]);

  const entries = board?.entries ?? [];
  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);
  const person = (entry: LeaderboardEntry) => <button className="lb-person" onClick={() => onProfile?.(entry.memberId)} disabled={!onProfile}><Avatar name={entry.name} url={entry.avatarUrl} /><span><strong>{entry.name}{entry.memberId === board?.me?.memberId && <em className="you">You</em>}</strong><small>{entry.country ?? '—'} · {shortAddress(entry.address)}</small></span></button>;

  const body = <>
    <div className="lb-head">
      <div className="seg">{([['global', 'Global'], ['country', country?.name ?? 'Country'], ['cult', 'My cult'], ['cults', 'Cults']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      <span className="count">{board ? 'Verified own trades' : tab === 'cults' ? 'Public cults' : ''}</span>
    </div>
    {tab === 'country' && !country ? <div className="empty"><span>Choose your country in Account to join its ranking.</span></div>
      : tab === 'cult' && !cultId ? <div className="empty"><span>Join a cult to see its ranking.</span></div>
      : loading ? <div className="podium">{Array.from({ length: 3 }, (_, i) => <div key={i} className="podium-card skel" />)}</div>
      : error ? <p className="notice-line">{error}</p>
      : tab === 'cults' ? (cults.length ? <section className="card flush"><div className="ctable">
        <div className="ctable-row ctable-head"><span>#</span><span>Cult</span><span className="hide-sm">Win rate</span><span className="hide-sm">Trades</span><span>All-time</span><span /></div>
        {cults.map(cult => <div className="ctable-row" key={cult.cultId}><span className={`rank rank-${cult.rank}`}>{cult.rank}</span><span className="ctable-cult"><RoomBadge icon={cult.name[0]!.toUpperCase()} kind="cult" /><span><strong>{cult.name}</strong><small>{cult.memberCount} members{cult.joined ? ' · Joined' : ''}</small></span></span><span className="num hide-sm">{cult.winRate == null ? '—' : percent(cult.winRate * 100)}</span><span className="num hide-sm">{cult.tradeCount}</span><span className={`num strong ${cult.realizedPnlUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(cult.realizedPnlUsd)}</span><span /></div>)}
      </div></section> : <div className="empty"><span>No public cult has a verified closed trade yet.</span></div>)
      : board ? <>
        {podium.length > 0 && <div className="podium">{podium.map(entry => <article key={entry.memberId} className={`podium-card place-${entry.rank}`}>
          <span className="podium-rank">{entry.rank === 1 ? <Crown size={16} /> : null}#{entry.rank}</span>
          <button className="podium-who" onClick={() => onProfile?.(entry.memberId)} disabled={!onProfile}><Avatar name={entry.name} url={entry.avatarUrl} /><strong>{entry.name}</strong></button>
          <strong className={`podium-pnl num ${entry.realizedPnlUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(entry.realizedPnlUsd)}</strong>
          <small>{entry.winRate == null ? '—' : percent(entry.winRate * 100)} win · {entry.tradeCount} trades</small>
        </article>)}</div>}
        <section className="card flush"><div className="ltable">
          <div className="ltable-row ltable-head"><span>#</span><span>Trader</span><span className="hide-sm">Win rate</span><span className="hide-sm">Trades</span><span>Own PnL</span></div>
          {rest.length ? rest.map(entry => <div className={`ltable-row ${entry.memberId === board.me?.memberId ? 'is-me' : ''}`} key={entry.memberId}><span className="rank">{entry.rank}</span>{person(entry)}<span className="num hide-sm">{entry.winRate == null ? '—' : percent(entry.winRate * 100)}</span><span className="num hide-sm">{entry.tradeCount}{entry.copiedTradeCount > 0 && <small> +{entry.copiedTradeCount}</small>}</span><span className={`num strong ${entry.realizedPnlUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(entry.realizedPnlUsd)}</span></div>) : entries.length === 0 ? <div className="empty"><span>No verified closed trades yet.</span></div> : null}
          {board.me && board.me.rank == null && <div className="ltable-row is-me"><span className="rank">—</span><span className="lb-person"><Avatar name={board.me.name} url={board.me.avatarUrl} /><span><strong>{board.me.name}<em className="you">You</em></strong><small>Unranked: needs a verified closed trade</small></span></span><span className="hide-sm" /><span className="hide-sm" /><span className="num">—</span></div>}
        </div></section>
      </> : <div className="empty"><span>Rankings are unavailable.</span></div>}
  </>;

  if (embedded) return <div className="lb">{body}</div>;
  return <div className="view one-col"><section className="view-main lb">
    <header className="page-head"><div><h1 className="display">Leaderboard</h1></div></header>
    {body}
  </section></div>;
}
