'use client';

import { useEffect, useMemo, useState } from 'react';
import { CandlestickChart, Lock, MessageCircle, Repeat2, X } from './icons';
import { getAccessToken } from '@/lib/auth';
import { getLeaderboard } from '@/lib/api';
import type { BoardPeriod, CultStanding, DiscoverCult, Leaderboard, LeaderboardEntry } from '@/lib/contracts';
import { dollars, percent, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';
import { RoomBadge } from './RoomBadge';
import { PerfBars, type PerfBar } from './PerfBars';

// What you see before joining a public cult: who's in it and how they've
// done, from the cult's own leaderboard (the sum of its members' verified,
// realized PnL) for all time, 30 days and 7 days.

type Props = { cult: DiscoverCult; standing: CultStanding | null; busy: boolean; onJoin: () => void; onClose: () => void; onProfile: (memberId: string) => void };

const compactSigned = (value: number) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${dollars(Math.abs(value), 0)}`;

const PERIODS: { id: BoardPeriod; label: string }[] = [{ id: '7d', label: '7D' }, { id: '30d', label: '30D' }, { id: 'all', label: 'All' }];

const totals = (board: Leaderboard | undefined) => {
  if (!board) return null;
  const trades = board.entries.reduce((sum, e) => sum + e.tradeCount, 0);
  const wins = board.entries.reduce((sum, e) => sum + (e.winRate ?? 0) * e.tradeCount, 0);
  return { pnl: board.entries.reduce((sum, e) => sum + e.realizedPnlUsd, 0), trades, winRate: trades > 0 ? wins / trades : null };
};

// The cult's record split into the slices its leaderboard periods give us:
// before the last 30 days, 30 to 8 days ago, and the last 7 days. Coarse,
// but real. The chosen period lights its slices.
type Totals = NonNullable<ReturnType<typeof totals>>;
function slices(all: Totals, d30: Totals, d7: Totals, createdAt: string): PerfBar[] {
  const bars: PerfBar[] = [];
  const older = all.trades - d30.trades;
  // A cult younger than 30 days has no "earlier" slice.
  if (older > 0 || Date.parse(createdAt) < Date.now() - 30 * 86_400_000) bars.push({ key: 'earlier', label: 'Earlier', title: 'Before the last 30 days', value: all.pnl - d30.pnl, total: all.pnl - d30.pnl, note: `${older} ${older === 1 ? 'trade' : 'trades'}` });
  const mid = d30.trades - d7.trades;
  bars.push({ key: 'mid', label: '30–8d', title: '8 to 30 days ago', value: d30.pnl - d7.pnl, total: all.pnl - d7.pnl, note: `${mid} ${mid === 1 ? 'trade' : 'trades'}` });
  bars.push({ key: 'week', label: 'Last 7d', title: 'Last 7 days', value: d7.pnl, total: all.pnl, note: `${d7.trades} ${d7.trades === 1 ? 'trade' : 'trades'}` });
  return bars;
}

function Faces({ entries }: { entries: LeaderboardEntry[] }) {
  return <span className="cpv-faces">{entries.slice(0, 3).map(e => <Avatar key={e.memberId} name={e.name} url={e.avatarUrl} />)}</span>;
}

export function CultPreview({ cult, standing, busy, onJoin, onClose, onProfile }: Props) {
  const [boards, setBoards] = useState<Partial<Record<BoardPeriod, Leaderboard>>>({});
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<BoardPeriod>('30d');

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
  const bars = useMemo(() => {
    const all = totals(boards.all), d30 = totals(boards['30d']), d7 = totals(boards['7d']);
    return all && d30 && d7 ? slices(all, d30, d7, cult.createdAt) : null;
  }, [boards, cult.createdAt]);
  // 7D lights the last slice, 30D the last two, All every one.
  const litFrom = bars ? (period === '7d' ? bars.length - 1 : period === '30d' ? bars.length - 2 : 0) : 0;
  const people = boards.all?.entries ?? [];
  const top = boards[period]?.entries.filter(e => e.tradeCount > 0).slice(0, 3) ?? [];
  const since = new Date(cult.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const up = (shown?.pnl ?? 0) >= 0;

  const allTime = totals(boards.all);
  const periodNote = period === 'all' ? 'all time' : period === '30d' ? 'in the last 30 days' : 'in the last 7 days';
  const traders = `${cult.memberCount} ${cult.memberCount === 1 ? 'trader' : 'traders'}`;

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="dialog cpv" role="dialog" aria-modal="true" aria-label={`${cult.name}, before you join`}>
      <button className="icon-btn dialog-close" title="Close" onClick={onClose}><X size={16} /></button>
      <header className="cpv-hero">
        {standing && <span className="cpv-rank"><b>#{standing.rank}</b> ranked cult</span>}
        <div className="cpv-hero-id">
          <span className="cpv-badge"><RoomBadge icon={cult.name[0]!.toUpperCase()} kind="cult" size="lg" /></span>
          <div className="cpv-hero-copy">
            <div className="cpv-name"><h2>{cult.name}</h2><span className="cpv-free">Free</span></div>
            <span className="cpv-meta">{people.length > 0 && <Faces entries={people} />}<span className="cpv-meta-text"><span>{traders}</span><span className="cpv-meta-public"><i>·</i>Public</span><span><i>·</i>Since {since}</span></span></span>
          </div>
        </div>
      </header>

      <div className="cpv-strip">
        <div><span>All-time PnL</span><strong className={`num ${(allTime?.pnl ?? 0) >= 0 ? 'up' : 'down'}`}>{allTime ? compactSigned(allTime.pnl) : '—'}</strong></div>
        <div><span>Win rate</span><strong className="num">{allTime?.winRate == null ? '—' : percent(allTime.winRate * 100)}</strong></div>
        <div><span>Closed trades</span><strong className="num">{allTime ? allTime.trades : '—'}</strong></div>
      </div>

      <section className="cpv-card">
        <div className="cpv-card-head"><h3>Performance</h3>
          <div className="seg seg--sm" role="tablist">{PERIODS.map(p => <button key={p.id} role="tab" aria-selected={period === p.id} className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>{p.label}</button>)}</div>
        </div>
        {error ? <p className="notice-line">{error}</p> : !loaded || !shown || !bars ? <><span className="skel cpv-skel-num" /><span className="skel cpv-skel-chart" /></> : <>
          <p className="cpv-pnl"><strong className={`num ${up ? 'up' : 'down'}`}>{signedDollars(shown.pnl)}</strong> <span>{periodNote} · {shown.trades} {shown.trades === 1 ? 'trade' : 'trades'} · {shown.winRate == null ? '—' : percent(shown.winRate * 100)} wins</span></p>
          <PerfBars bars={bars} lit={i => i >= litFrom} />
        </>}
      </section>

      <section className="cpv-section">
        <div className="cpv-card-head"><h3>Leading the cult</h3><small>{period === 'all' ? 'All time' : period === '30d' ? 'Last 30 days' : 'Last 7 days'}</small></div>
        {!loaded ? <span className="skel cpv-skel-row" /> : top.length ? <div className="cpv-traders">{top.map((e, i) => <button key={e.memberId} className="cpv-trader" onClick={() => onProfile(e.memberId)}>
          <span className="cpv-trader-top"><Avatar name={e.name} url={e.avatarUrl} /><span className="cpv-trader-rank">{i + 1}</span></span>
          <strong className="cpv-trader-name">{e.name}</strong>
          <strong className={`num cpv-trader-pnl ${e.realizedPnlUsd >= 0 ? 'up' : 'down'}`}>{compactSigned(e.realizedPnlUsd)}</strong>
          <small>{e.winRate == null ? '—' : percent(e.winRate * 100)} wins · {e.tradeCount} trades</small>
        </button>)}</div> : <p className="field-note">No closed trades yet. The record fills in as members close trades.</p>}
      </section>

      <section className="cpv-section">
        <div className="cpv-card-head"><h3><Lock size={14} /> Unlocks when you join</h3></div>
        <div className="cpv-perks">
          <div><span className="cpv-perk-icon"><MessageCircle size={17} /></span><strong>Cult chat</strong><small>Talk trades with every member</small></div>
          <div><span className="cpv-perk-icon"><CandlestickChart size={17} /></span><strong>Live positions</strong><small>Members&rsquo; trades on your chart, with PnL</small></div>
          <div><span className="cpv-perk-icon"><Repeat2 size={17} /></span><strong>Auto-follow</strong><small>Optional, off until you set limits</small></div>
        </div>
      </section>

      <footer className="cpv-foot">
        <span className="cpv-foot-copy">{people.length > 0 && <Faces entries={people} />}<span className="cpv-foot-text"><strong>{traders} already in</strong><small>You keep your own wallet</small></span></span>
        <button className="btn btn-primary" disabled={busy} onClick={onJoin}>{busy ? 'Joining…' : 'Join cult'}</button>
      </footer>
    </section>
  </div>;
}
