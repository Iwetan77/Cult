'use client';

import { useEffect, useMemo, useState } from 'react';
import { Lock, X } from 'lucide-react';
import { getAccessToken } from '@/lib/auth';
import { getLeaderboard } from '@/lib/api';
import type { BoardPeriod, CultStanding, DiscoverCult, Leaderboard, LeaderboardEntry } from '@/lib/contracts';
import { percent, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';
import { RoomBadge } from './RoomBadge';

// What you see before joining a public cult: who's in it and how they've
// done, from the cult's own leaderboard (the sum of its members' verified,
// realized PnL) for all time, 30 days and 7 days.

type Props = { cult: DiscoverCult; standing: CultStanding | null; busy: boolean; onJoin: () => void; onClose: () => void; onProfile: (memberId: string) => void };

const PERIODS: { id: BoardPeriod; label: string }[] = [{ id: '7d', label: '7D' }, { id: '30d', label: '30D' }, { id: 'all', label: 'All' }];

const totals = (board: Leaderboard | undefined) => {
  if (!board) return null;
  const trades = board.entries.reduce((sum, e) => sum + e.tradeCount, 0);
  const wins = board.entries.reduce((sum, e) => sum + (e.winRate ?? 0) * e.tradeCount, 0);
  return { pnl: board.entries.reduce((sum, e) => sum + e.realizedPnlUsd, 0), trades, winRate: trades > 0 ? wins / trades : null };
};

// Cumulative PnL at the points the periods give us (start, 30d ago, 7d ago,
// now), so the line is coarse but real.
type Point = { x: number; v: number; label: string; minor?: boolean };
function curvePoints(period: BoardPeriod, all: number, d30: number, d7: number): Point[] {
  if (period === '7d') return [{ x: 0, v: 0, label: '7d ago' }, { x: 1, v: d7, label: 'Now' }];
  if (period === '30d') return [{ x: 0, v: 0, label: '30d ago' }, { x: 23 / 30, v: d30 - d7, label: '7d ago' }, { x: 1, v: d30, label: 'Now' }];
  return [{ x: 0, v: 0, label: 'Start' }, { x: 0.6, v: all - d30, label: '30d ago' }, { x: 0.88, v: all - d7, label: '7d ago', minor: true }, { x: 1, v: all, label: 'Now' }];
}

function Curve({ points, up }: { points: Point[]; up: boolean }) {
  const w = 600, h = 150, pad = 6;
  const vs = points.map(p => p.v);
  const min = Math.min(0, ...vs), max = Math.max(0, ...vs);
  const x = (t: number) => pad + t * (w - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / Math.max(1e-9, max - min)) * (h - pad * 2);
  // Flat tangents at each point: smooth S-bends with no overshoot.
  const line = points.map((p, i) => {
    if (i === 0) return `M${x(p.x).toFixed(1)},${y(p.v).toFixed(1)}`;
    const prev = points[i - 1]!;
    const mid = (x(prev.x) + x(p.x)) / 2;
    return `C${mid.toFixed(1)},${y(prev.v).toFixed(1)} ${mid.toFixed(1)},${y(p.v).toFixed(1)} ${x(p.x).toFixed(1)},${y(p.v).toFixed(1)}`;
  }).join(' ');
  return <svg className={`cpv-curve ${up ? 'is-up' : 'is-down'}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="cpv-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".26" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
    <line x1={pad} x2={w - pad} y1={y(0)} y2={y(0)} className="cpv-zero" />
    <path d={`${line} L${x(1)},${h} L${x(0)},${h} Z`} fill="url(#cpv-fill)" />
    <path d={line} className="cpv-line" />
  </svg>;
}

function Faces({ entries }: { entries: LeaderboardEntry[] }) {
  return <span className="cpv-faces">{entries.slice(0, 3).map(e => <Avatar key={e.memberId} name={e.name} url={e.avatarUrl} />)}</span>;
}

export function CultPreview({ cult, standing, busy, onJoin, onClose, onProfile }: Props) {
  const [boards, setBoards] = useState<Partial<Record<BoardPeriod, Leaderboard>>>({});
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<BoardPeriod>('all');

  useEffect(() => {
    let active = true;
    getAccessToken().then(async token => {
      if (!token) throw new Error('Sign in again to see this cult.');
      const [all, d30, d7] = await Promise.all((['all', '30d', '7d'] as const).map(p => getLeaderboard(token, 'cult', cult.id, p)));
      if (active) setBoards({ all, '30d': d30, '7d': d7 });
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Cult details unavailable.'); });
    return () => { active = false; };
  }, [cult.id]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const loaded = !!boards.all && !!boards['30d'] && !!boards['7d'];
  const shown = totals(boards[period]);
  const points = useMemo(() => {
    const all = totals(boards.all), d30 = totals(boards['30d']), d7 = totals(boards['7d']);
    return all && d30 && d7 ? curvePoints(period, all.pnl, d30.pnl, d7.pnl) : null;
  }, [boards, period]);
  const people = boards.all?.entries ?? [];
  const top = boards[period]?.entries.filter(e => e.tradeCount > 0).slice(0, 3) ?? [];
  const since = new Date(cult.createdAt).toLocaleDateString([], { month: 'short', year: 'numeric' });
  const up = (shown?.pnl ?? 0) >= 0;

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="dialog cpv" role="dialog" aria-modal="true" aria-label={`${cult.name}, before you join`}>
      <button className="icon-btn dialog-close" title="Close" onClick={onClose}><X size={16} /></button>
      <div className="cpv-banner" />
      <div className="cpv-id">
        <span className="cpv-badge"><RoomBadge icon={cult.name[0]!.toUpperCase()} kind="cult" size="lg" /></span>
        <div className="cpv-title"><h2>{cult.name}</h2>{standing && <span className="cpv-rank">Rank {standing.rank}</span>}</div>
        <div className="cpv-meta">{people.length > 0 && <Faces entries={people} />}<span>{cult.memberCount} {cult.memberCount === 1 ? 'trader' : 'traders'} · Public · Since {since}</span></div>
      </div>

      <section className="cpv-card">
        <div className="cpv-card-head"><span>Cult performance</span>
          <div className="seg seg--sm" role="tablist">{PERIODS.map(p => <button key={p.id} role="tab" aria-selected={period === p.id} className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>{p.label}</button>)}</div>
        </div>
        {error ? <p className="notice-line">{error}</p> : !loaded || !shown || !points ? <><span className="skel cpv-skel-num" /><span className="skel cpv-skel-chart" /></> : <>
          <div className="cpv-pnl"><strong className={`num ${up ? 'up' : 'down'}`}>{signedDollars(shown.pnl)}</strong><span className={`cpv-chip ${up ? 'up' : 'down'}`}>{shown.trades} closed {shown.trades === 1 ? 'trade' : 'trades'}</span></div>
          <Curve points={points} up={up} />
          <div className="cpv-ticks">{points.map(p => <span key={p.label} className={p.minor ? 'minor' : undefined} style={{ left: `${p.x * 100}%` }}>{p.label}</span>)}</div>
          <div className="cpv-stats">
            <div><strong className="num">{shown.winRate == null ? '—' : percent(shown.winRate * 100)}</strong><span>Win rate</span></div>
            <div><strong className="num">{shown.trades}</strong><span>Trades</span></div>
            <div><strong className="num">{boards.all!.rankedCount}</strong><span>Traders ranked</span></div>
          </div>
        </>}
      </section>

      <section className="cpv-card">
        <div className="cpv-card-head"><span>Top traders</span><small>{period === 'all' ? 'All time' : period === '30d' ? 'Last 30 days' : 'Last 7 days'}</small></div>
        {!loaded ? <span className="skel cpv-skel-row" /> : top.length ? <div className="cpv-traders">{top.map((e, i) => <button key={e.memberId} className="cpv-trader" onClick={() => onProfile(e.memberId)}>
          <span className="cpv-trader-rank">{i + 1}</span>
          <Avatar name={e.name} url={e.avatarUrl} />
          <span className="cpv-trader-name"><strong>{e.name}</strong><small>{e.winRate == null ? '—' : percent(e.winRate * 100)} win rate · {e.tradeCount} trades</small></span>
          <strong className={`num ${e.realizedPnlUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(e.realizedPnlUsd)}</strong>
        </button>)}</div> : <p className="field-note">No closed trades yet. The record fills in as members close trades.</p>}
      </section>

      <section className="cpv-card cpv-join">
        <h3>Free</h3>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={onJoin}>{busy ? 'Joining…' : 'Join cult'}</button>
        <p className="field-note">You keep your own wallet. Auto-follow stays off until you turn it on.</p>
        <div className="cpv-join-foot">{people.length > 0 && <Faces entries={people} />}<span>{cult.memberCount} {cult.memberCount === 1 ? 'trader' : 'traders'} already in</span></div>
      </section>
      <p className="cpv-lock"><Lock size={13} /> Chat and live positions unlock when you join</p>
    </section>
  </div>;
}
