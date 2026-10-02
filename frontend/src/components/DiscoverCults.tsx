'use client';

import { useEffect, useMemo, useState } from 'react';
import { getAccessToken } from '@/lib/auth';
import { ArrowRight, Check, Link2, Plus, RefreshCw } from 'lucide-react';
import { discoverCults, getCultStandings } from '@/lib/api';
import type { CultStanding, DiscoverCult } from '@/lib/contracts';
import { percent, signedDollars } from '@/lib/format';
import { Leaderboards } from './Leaderboards';
import { RoomBadge } from './RoomBadge';

type Props = { busy: boolean; onJoin: (cultId: string) => void; country: { code: string; name: string } | null; cultId: string | null; onProfile: (memberId: string) => void; search: string; onCreate: () => void; onInvite: () => void };

type Row = DiscoverCult & { standing: CultStanding | null };

export function DiscoverCults({ busy, onJoin, country, cultId, onProfile, search, onCreate, onInvite }: Props) {
  const [tab, setTab] = useState<'cults' | 'rankings'>('cults');
  const [cults, setCults] = useState<DiscoverCult[]>([]);
  const [standings, setStandings] = useState<CultStanding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    getAccessToken().then(async token => {
      if (!token) throw new Error('Sign in again to discover Cults.');
      const [list, ranks] = await Promise.all([discoverCults(token), getCultStandings(token).catch(() => ({ entries: [] as CultStanding[] }))]);
      if (active) { setCults(list.cults); setStandings(ranks.entries); setError(null); }
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : 'Discovery is unavailable.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  const rows: Row[] = useMemo(() => cults.map(c => ({ ...c, standing: standings.find(s => s.cultId === c.id) ?? null }))
    .filter(c => c.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => (a.standing?.rank ?? 1e6) - (b.standing?.rank ?? 1e6)), [cults, standings, search]);
  const top = rows.filter(r => r.standing).slice(0, 4);

  const join = (row: Row) => row.joined ? <span className="joined"><Check size={14} /> Joined</span> : <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onJoin(row.id)}>Join <ArrowRight size={14} /></button>;

  return <div className="view one-col">
    <section className="view-main">
      <section className="discover-hero reveal">
        <div className="discover-hero-copy">
          <span className="eyebrow">Discover</span>
          <h1 className="display">Find your cult</h1>
          <p>Public cults trade in the open. Join one and every member&apos;s position shows on your chart, live, with PnL. Turn on Auto-follow to copy them.</p>
          <div className="row-gap"><button className="btn btn-primary" onClick={onCreate}><Plus size={16} /> Create a cult</button><button className="btn btn-glass" onClick={onInvite}><Link2 size={16} /> Use an invite</button></div>
        </div>
      </section>

      <div className="tabs tabs--page">
        <button className={tab === 'cults' ? 'on' : ''} onClick={() => setTab('cults')}>Cults</button>
        <button className={tab === 'rankings' ? 'on' : ''} onClick={() => setTab('rankings')}>Leaderboards</button>
        <button className="icon-btn tabs-end" title="Refresh" onClick={() => { setLoading(true); setRevision(value => value + 1); }}><RefreshCw size={16} /></button>
      </div>

      {tab === 'rankings' ? <Leaderboards embedded country={country} cultId={cultId} onProfile={onProfile} /> : loading ? <div className="cult-cards">{Array.from({ length: 4 }, (_, i) => <div key={i} className="cult-card skel" />)}</div> : error ? <p className="notice-line">{error}</p> : <>
        {top.length > 0 && !search.trim() && <section className="block">
          <div className="block-head"><h2>Top performing</h2></div>
          <div className="cult-cards">{top.map((row, i) => <article key={row.id} className={`cult-card reveal ${i === 0 ? 'is-first' : ''}`} style={{ '--d': `${i * 60}ms` } as React.CSSProperties}>
            <div className="cult-card-top"><RoomBadge icon={row.name[0]!.toUpperCase()} kind="cult" size="lg" /><span className="cult-card-rank">#{row.standing!.rank}</span></div>
            <h3>{row.name}</h3>
            <small>{row.memberCount} members · {row.standing!.tradeCount} trades</small>
            <strong className={`cult-card-pnl num ${row.standing!.realizedPnlUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(row.standing!.realizedPnlUsd)}</strong>
            <div className="cult-card-foot"><span>{row.standing!.winRate == null ? '—' : percent(row.standing!.winRate * 100)} win rate</span>{join(row)}</div>
          </article>)}</div>
        </section>}

        <section className="card flush">
          <div className="table-tools"><h2>All public cults</h2><span className="count">{rows.length}</span></div>
          {rows.length === 0 ? <div className="empty"><span>{search.trim() ? 'No public cults match your search.' : 'No public cults yet. Be the first.'}</span></div> : <div className="ctable">
            <div className="ctable-row ctable-head"><span>#</span><span>Cult</span><span className="hide-sm">Win rate</span><span className="hide-sm">Trades</span><span>All-time</span><span /></div>
            {rows.map(row => <div className="ctable-row" key={row.id}>
              <span className="rank">{row.standing?.rank ?? '—'}</span>
              <span className="ctable-cult"><RoomBadge icon={row.name[0]!.toUpperCase()} kind="cult" /><span><strong>{row.name}</strong><small>{row.memberCount} {row.memberCount === 1 ? 'member' : 'members'}</small></span></span>
              <span className="num hide-sm">{row.standing?.winRate == null ? '—' : percent(row.standing.winRate * 100)}</span>
              <span className="num hide-sm">{row.standing?.tradeCount ?? '—'}</span>
              <span className={`num strong ${(row.standing?.realizedPnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{row.standing ? signedDollars(row.standing.realizedPnlUsd) : '—'}</span>
              <span className="ctable-act">{join(row)}</span>
            </div>)}
          </div>}
        </section>
      </>}
    </section>
  </div>;
}
