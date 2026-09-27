'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { getCultStandings, getLeaderboard } from '@/lib/api';
import type { CultStanding, Leaderboard } from '@/lib/contracts';
import { dollars, percent, shortAddress, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';

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

  const visible = board?.entries.filter(entry => entry.memberId !== board.me?.memberId) ?? [];

  return <section className={embedded ? 'rankings rankings-embedded' : 'full-workspace rankings'}>
    <div className="screen-head"><div><span className="eyebrow">VERIFIED OWN TRADES</span><h1>Leaderboards</h1></div><span className="rankings-count">{board ? `${board.rankedCount} ranked / ${board.memberCount} members` : ''}</span></div>
    <div className="ranking-tabs" role="tablist" aria-label="Leaderboard scope">
      {([['global', 'Global'], ['country', 'My country'], ['cult', 'This Cult'], ['cults', 'Cults']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div className="ranking-content">
      {tab === 'country' && !country ? <p className="field-note">Choose your country in Wallet to join its ranking.</p> : tab === 'cult' && !cultId ? <p className="field-note">Join a Cult to see its ranking.</p> : loading ? <p className="field-note">Loading rankings…</p> : error ? <p className="wallet-warning">{error}</p> : tab === 'cults' ? cults.length ? <div className="ranking-table">
        <div className="ranking-header"><span>RANK / CULT</span><span>OWN PNL</span><span>WIN RATE</span><span>TRADES</span></div>
        {cults.map(cult => <div className="ranking-row" key={cult.cultId}><div><span className="rank-number">{cult.rank}</span><strong>{cult.name}</strong><small>{cult.memberCount} members{cult.joined ? ' · Joined' : ''}</small></div><b className={cult.realizedPnlUsd >= 0 ? 'positive' : 'negative'}>{signedDollars(cult.realizedPnlUsd)}</b><span>{cult.winRate == null ? '—' : percent(cult.winRate * 100)}</span><span>{cult.tradeCount}</span></div>)}
      </div> : <p className="field-note">No public Cult has a verified closed trade yet.</p> : board ? <>
        <div className="ranking-table">
          <div className="ranking-header"><span>RANK / TRADER</span><span>OWN PNL</span><span>WIN RATE</span><span>TRADES</span></div>
          {visible.length ? visible.map(entry => <div className="ranking-row" key={entry.memberId}><div className="ranking-trader"><span className="rank-number">{entry.rank}</span><Avatar name={entry.name} url={entry.avatarUrl} /><button className="ranking-person" onClick={() => onProfile?.(entry.memberId)} disabled={!onProfile}>{entry.name}</button><small>{entry.country ?? '—'} · {shortAddress(entry.address)}{entry.copiedTradeCount > 0 ? ` · +${entry.copiedTradeCount} copied` : ''}</small></div><b className={entry.realizedPnlUsd >= 0 ? 'positive' : 'negative'}>{signedDollars(entry.realizedPnlUsd)}</b><span>{entry.winRate == null ? '—' : percent(entry.winRate * 100)}</span><span>{entry.tradeCount}</span></div>) : <p className="field-note">No verified closed trades yet.</p>}
        </div>
        {board.me && <div className="ranking-me"><span className="tiny-label">YOU</span><div className="ranking-row"><div className="ranking-trader"><span className="rank-number">{board.me.rank ?? '—'}</span><Avatar name={board.me.name} url={board.me.avatarUrl} /><strong>{board.me.name}</strong><small>{shortAddress(board.me.address)}{board.me.copiedTradeCount > 0 ? ` · +${board.me.copiedTradeCount} copied` : ''}</small></div><b className={board.me.realizedPnlUsd >= 0 ? 'positive' : 'negative'}>{board.me.rank == null ? dollars(null) : signedDollars(board.me.realizedPnlUsd)}</b><span>{board.me.winRate == null ? '—' : percent(board.me.winRate * 100)}</span><span>{board.me.tradeCount}</span></div>{board.me.rank == null && <p className="field-note">Unranked: needs a verified closed trade.</p>}</div>}
      </> : <p className="field-note">Rankings are unavailable.</p>}
    </div>
  </section>;
}
