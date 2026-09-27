'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { discoverCults } from '@/lib/api';
import type { DiscoverCult } from '@/lib/contracts';
import { Leaderboards } from './Leaderboards';

type Props = { busy: boolean; onJoin: (cultId: string) => void; country: { code: string; name: string } | null; cultId: string | null; onProfile: (memberId: string) => void; search: string };

export function DiscoverCults({ busy, onJoin, country, cultId, onProfile, search }: Props) {
  const [tab, setTab] = useState<'cults' | 'rankings'>('cults');
  const [cults, setCults] = useState<DiscoverCult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to discover Cults.');
      return discoverCults(token);
    }).then(result => {
      if (active) { setCults(result.cults); setError(null); }
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : 'Discovery is unavailable.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  const visibleCults = cults.filter(cult => cult.name.toLowerCase().includes(search.trim().toLowerCase()));

  return <main className="full-workspace discovery">
    <div className="screen-head"><div><span className="eyebrow">PUBLIC CULTS</span><h1>Discover</h1></div><button className="icon-button" title="Refresh Cults" onClick={() => { setLoading(true); setRevision(value => value + 1); }}><RefreshCw size={17} /></button></div>
    <div className="discovery-tabs"><button className={tab === 'cults' ? 'active' : ''} onClick={() => setTab('cults')}>Cults</button><button className={tab === 'rankings' ? 'active' : ''} onClick={() => setTab('rankings')}>Leaderboards</button></div>
    {tab === 'rankings' ? <Leaderboards embedded country={country} cultId={cultId} onProfile={onProfile} /> : <div className="discovery-body"><div className="discovery-list">
      {loading ? <p className="field-note">Loading public Cults…</p> : error ? <p className="wallet-warning">{error}</p> : visibleCults.length === 0 ? <p className="field-note">{search.trim() ? 'No public Cults match your search.' : 'No public Cults yet.'}</p> : visibleCults.map(cult => <div className="discovery-row" key={cult.id}>
        <span className="clan-avatar">{cult.name.slice(0, 1).toUpperCase()}</span>
        <div><strong>{cult.name}</strong><small>{cult.memberCount} {cult.memberCount === 1 ? 'member' : 'members'}</small></div>
        {cult.joined ? <span className="discovery-joined">Joined</span> : <button className="outline" disabled={busy} onClick={() => onJoin(cult.id)}>Join <ArrowRight size={14} /></button>}
      </div>)}
    </div></div>}
  </main>;
}
