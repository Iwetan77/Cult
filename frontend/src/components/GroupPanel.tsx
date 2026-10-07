'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@/lib/auth';
import { ArrowRight, Copy, Globe2, Lock, ShieldCheck, X } from './icons';
import { getLeaderboard } from '@/lib/api';
import type { BackendConfig, ChartMarker, ChartSnapshot, ChatRoom, Clan, Leaderboard, MirrorPolicy } from '@/lib/contracts';
import { dollars, percent, price, signedDollars } from '@/lib/format';
import { SharedChart } from './SharedChart';
import { Avatar } from './Avatar';
import { RoomBadge } from './RoomBadge';

type Props = {
  room: ChatRoom; cult: Clan | null; config: BackendConfig | null; snapshot: ChartSnapshot | null;
  selected: ChartMarker | null; busy: boolean; signerPrompt: string | null; onGrantSigner: () => void;
  onFollowOn: (policy: MirrorPolicy) => Promise<void>; onFollowOff: () => Promise<void>;
  onMarket: (marketId: string) => void; onMarker: (marker: ChartMarker) => void; onOpenTrade: () => void;
  onGuideDrop: (marker: ChartMarker, kind: 'takeProfit' | 'stopLoss', price: number) => void;
  onInvite: () => void; onVisibility: (visibility: 'private' | 'public') => void;
  onLeave: () => Promise<void>; onProfile: (memberId: string) => void;
  // Admins share trades with the cult and make other members admins.
  meId?: string; onSetAdmin?: (memberId: string, admin: boolean) => Promise<void>;
};

function RoomRanking({ room, cultId, onProfile }: { room: ChatRoom; cultId?: string; onProfile: (id: string) => void }) {
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to view rankings.');
      return getLeaderboard(token, room.kind === 'cult' ? 'cult' : room.kind, cultId);
    }).then(result => { if (active) setBoard(result); }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : 'Rankings unavailable.');
    });
    return () => { active = false; };
  }, [room.id, room.kind, cultId]);

  return <div className="ranking">{error ? <p className="notice-line">{error}</p> : !board ? Array.from({ length: 5 }, (_, i) => <span key={i} className="skel rail-skel" />) : board.entries.length ? board.entries.slice(0, 8).map(entry => <button key={entry.memberId} className="ranking-row" onClick={() => onProfile(entry.memberId)}>
    <span className={`rank rank-${entry.rank}`}>{entry.rank}</span><Avatar name={entry.name} url={entry.avatarUrl} />
    <span className="ranking-who"><strong>{entry.name}</strong><small>{entry.winRate == null ? '—' : percent(entry.winRate * 100)} win{entry.copiedTradeCount ? ` · +${entry.copiedTradeCount} copied` : ''}</small></span>
    <b className={`num ${entry.realizedPnlUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(entry.realizedPnlUsd)}</b>
  </button>) : <div className="empty compact"><span>No verified closed trades yet.</span></div>}
    {board?.me && <div className="ranking-me"><span>You · {board.me.rank == null ? 'Unranked' : `#${board.me.rank}`}</span><b className="num">{board.me.rank == null ? 'No closed trade' : signedDollars(board.me.realizedPnlUsd)}</b></div>}
  </div>;
}

export function GroupPanel({ room, cult, config, snapshot, selected, busy, signerPrompt, onGrantSigner, onFollowOn, onFollowOff, onMarket, onMarker, onOpenTrade, onGuideDrop, onInvite, onVisibility, onLeave, onProfile, meId, onSetAdmin }: Props) {
  const [tab, setTab] = useState<'positions' | 'stats' | 'members' | 'settings'>('positions');
  const [followSheet, setFollowSheet] = useState(false);
  const [maxUsd, setMaxUsd] = useState('');
  const [balancePct, setBalancePct] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [adminBusy, setAdminBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const market = snapshot?.selectedMarket;
  const markers = snapshot?.markers.filter(item => item.marketId === market?.id) ?? [];

  const openFollowSheet = () => {
    const current = cult?.myPolicy;
    setMaxUsd(String(current?.enabled ? current.maxUsdPerTrade : config?.autoFollowDefaults.maxUsdPerTrade ?? 50));
    setBalancePct(String(current?.enabled ? current.balancePercentCap : config?.autoFollowDefaults.balancePercentCap ?? 10));
    setError(null);
    setFollowSheet(true);
  };
  const turnOn = async () => {
    const policy: MirrorPolicy = { enabled: true, maxUsdPerTrade: Number(maxUsd), balancePercentCap: Number(balancePct) };
    if (!Number.isFinite(policy.maxUsdPerTrade) || policy.maxUsdPerTrade < 1 || !Number.isFinite(policy.balancePercentCap) || policy.balancePercentCap <= 0 || policy.balancePercentCap > 100) {
      setError('Enter valid Auto-follow limits.');
      return;
    }
    try { await onFollowOn(policy); setFollowSheet(false); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Auto-follow could not be enabled.'); }
  };

  if (room.kind !== 'cult' || !cult) return <aside className="group">
    <section className="card group-hero">
      <RoomBadge icon={room.icon} kind={room.kind} size="lg" />
      <div><h2>{room.name}</h2><small>{room.memberCount.toLocaleString()} traders</small></div>
    </section>
    <section className="card"><div className="card-head"><h2>Leaderboard</h2><span className="count">All time</span></div><RoomRanking room={room} onProfile={onProfile} /></section>
  </aside>;

  const members = snapshot?.members ?? [];
  const verified = members.filter(m => m.verified);
  const totalPnl = verified.reduce((s, m) => s + (m.realizedPnlUsd ?? 0), 0);
  const trades = verified.reduce((s, m) => s + m.tradeCount, 0);
  const winRates = verified.filter(m => m.winRate != null);
  const avgWin = winRates.length ? winRates.reduce((s, m) => s + (m.winRate ?? 0), 0) / winRates.length : null;
  const best = [...verified].sort((a, b) => (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0))[0];
  const openPositions = snapshot?.markers.length ?? 0;
  const longShare = snapshot?.markers.length ? snapshot.markers.filter(m => m.side !== 'short').length / snapshot.markers.length : null;
  const policy = cult.myPolicy;

  return <aside className="group">
    <section className="card group-hero">
      <RoomBadge icon={room.icon} kind="cult" size="lg" />
      <div><h2>{cult.name}</h2><small className="group-hero-meta">{cult.visibility === 'public' ? <Globe2 size={12} /> : <Lock size={12} />}{cult.visibility === 'public' ? 'Public' : 'Private'} · {cult.memberCount} {cult.memberCount === 1 ? 'member' : 'members'} · {openPositions} open</small></div>
      <button className="btn btn-ghost btn-sm" onClick={onInvite}><Copy size={14} /> Invite</button>
    </section>

    <section className={`card follow ${cult.autoFollow ? 'is-on' : ''}`}>
      <label className="follow-row">
        <span><strong>Auto-follow</strong><small>{cult.autoFollow ? 'Trades from this cult copy into your wallet' : 'Copy this cult’s trades automatically'}</small></span>
        <input className="switch" type="checkbox" checked={cult.autoFollow} disabled={busy} onChange={event => { if (event.target.checked) openFollowSheet(); else void onFollowOff(); }} />
      </label>
      {cult.autoFollow && policy && !followSheet && <div className="follow-alloc"><span>Allocation</span><b className="num">{dollars(policy.maxUsdPerTrade)} <small>/ trade</small></b><small>up to {policy.balancePercentCap}% of balance</small><button className="link" onClick={openFollowSheet}>Edit</button></div>}
      {cult.autoFollow && signerPrompt && <div className="follow-alert"><p>{signerPrompt}. Copies wait until your wallet confirms.</p><button className="btn btn-ghost btn-sm btn-block" disabled={busy} onClick={onGrantSigner}><ShieldCheck size={14} /> Approve signer</button></div>}
      {followSheet && <div className="follow-sheet">
        <div className="follow-sheet-head"><strong>Set your limits</strong><button className="icon-btn icon-btn--sm" title="Close" onClick={() => setFollowSheet(false)}><X size={14} /></button></div>
        <div className="follow-field"><div className="ticket-row"><span className="ticket-label">Max per trade</span><b className="num">${Number(maxUsd || 0).toLocaleString()}</b></div>
          <input type="range" min={5} max={1000} step={5} value={Number(maxUsd) || 5} onChange={event => setMaxUsd(event.target.value)} aria-label="Max dollars per trade" style={{ '--fill': `${((Number(maxUsd) || 5) - 5) / 995 * 100}%` } as React.CSSProperties} /></div>
        <div className="follow-field"><div className="ticket-row"><span className="ticket-label">Max of balance</span><b className="num">{balancePct || 0}%</b></div>
          <input type="range" min={1} max={100} step={1} value={Number(balancePct) || 1} onChange={event => setBalancePct(event.target.value)} aria-label="Max percent of balance" style={{ '--fill': `${((Number(balancePct) || 1) - 1) / 99 * 100}%` } as React.CSSProperties} /></div>
        <p className="fine">Your wallet signs these limits. Cult can never move more than this per copy.</p>
        <button className="btn btn-primary btn-sm btn-block" disabled={busy} onClick={turnOn}><ShieldCheck size={15} /> {cult.autoFollow ? 'Save limits' : 'Turn on'}</button>
        {error && <p className="notice-line">{error}</p>}
      </div>}
    </section>

    <section className="card">
      <div className="tabs tabs--fill">{([['positions', 'Positions'], ['stats', 'Stats'], ['members', 'Members'], ['settings', 'Settings']] as const).map(([id, label]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      {tab === 'positions' ? <div className="group-pos">
        <div className="chips chips--scroll">{snapshot?.markets.map(item => <button key={`${item.venue}:${item.id}`} className={item.id === market?.id ? 'on' : ''} onClick={() => onMarket(item.id)}>{item.symbol.replace(/-PERP$/, '')}</button>)}</div>
        <div className="mini-chart"><SharedChart candles={snapshot?.candles ?? []} markers={markers} market={market ?? { venue: 'perpl', id: '', symbol: '', baseSymbol: '', quoteSymbol: 'USD', maxLeverage: 1, makerFeeBps: null, takerFeeBps: null }} selectedId={selected?.id ?? null} onSelect={onMarker} onGuideDrop={onGuideDrop} guidesDisabled={busy} avatars={Object.fromEntries(members.map(x => [x.id, x.avatarUrl]))} /></div>
        <div className="feed feed--compact">{markers.length ? markers.map(marker => <button className={`feed-row ${selected?.id === marker.id ? 'on' : ''}`} key={marker.id} onClick={() => onMarker(marker)}>
          <Avatar name={marker.memberName} url={members.find(m => m.id === marker.memberId)?.avatarUrl} />
          <span className="feed-who"><strong>{marker.isMine ? 'You' : marker.memberName}</strong><small>{marker.origin === 'auto_mirror' ? 'Auto copy' : marker.origin === 'manual_stack' ? 'Stacked' : 'Own trade'} · {price(marker.entryPrice)}</small></span>
          <span className={`side-chip ${marker.side}`}>{marker.side.toUpperCase()}{marker.leverage ? ` ${marker.leverage}x` : ''}</span>
          <b className={`num ${(marker.pnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{marker.venue === 'perpl' ? (marker.pnlUsd == null ? 'Pending' : signedDollars(marker.pnlUsd)) : dollars(marker.valueUsd)}</b>
        </button>) : <div className="empty compact"><span>No open positions on {market?.symbol ?? 'this market'}.</span></div>}</div>
        <button className="btn btn-primary btn-sm btn-block" onClick={onOpenTrade}>{selected ? (selected.isMine ? 'Manage my trade' : 'Open trade & stack') : 'Open full chart'} <ArrowRight size={14} /></button>
      </div> : tab === 'stats' ? <div className="group-stats">
        <div className="stat-grid">
          <div><span>All-time PnL</span><b className={`num ${totalPnl >= 0 ? 'up' : 'down'}`}>{signedDollars(totalPnl)}</b></div>
          <div><span>Win rate</span><b className="num">{avgWin == null ? '—' : percent(avgWin * 100)}</b></div>
          <div><span>Trades</span><b className="num">{trades.toLocaleString()}</b></div>
          <div><span>Open now</span><b className="num">{openPositions}</b></div>
          <div><span>Bias</span><b>{longShare == null ? '—' : longShare >= 0.6 ? 'Long-biased' : longShare <= 0.4 ? 'Short-biased' : 'Balanced'}</b></div>
          <div><span>Top trader</span><b>{best?.name ?? '—'}</b></div>
        </div>
        <div className="card-head sub"><h3>Ranking</h3></div>
        <RoomRanking room={room} cultId={cult.id} onProfile={onProfile} />
      </div> : tab === 'members' ? <div className="mini-members">{members.length ? members.map(member => <div key={member.id} className="mini-member">
        <button className="mini-member-main" onClick={() => onProfile(member.id)}><Avatar name={member.name} url={member.avatarUrl} /><span><strong>{member.name}{member.admin && <i className="admin-tag">Admin</i>}</strong><small>{member.verified ? `${member.tradeCount} trades · ${member.winRate == null ? '—' : percent(member.winRate * 100)} win` : 'Unverified'}</small></span><b className={`num ${(member.realizedPnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{member.realizedPnlUsd == null ? '—' : signedDollars(member.realizedPnlUsd)}</b></button>
        {cult.isAdmin && onSetAdmin && member.id !== meId && <button className="btn btn-ghost btn-sm" disabled={busy || adminBusy === member.id} onClick={() => { setAdminBusy(member.id); void onSetAdmin(member.id, !member.admin).finally(() => setAdminBusy(null)); }}>{member.admin ? 'Remove admin' : 'Make admin'}</button>}
      </div>) : <div className="empty compact"><span>Member records appear after the indexer syncs.</span></div>}</div>
      : <div className="group-settings">
        <div className="setting"><div><strong>{cult.isAdmin ? 'You’re an admin' : 'You’re a member'}</strong><small>{cult.isAdmin
          ? 'Your trades are shared here and copied by members on Auto-follow. Make others admins from Members.'
          : 'Only admins share trades here; yours stay yours. Turn on Auto-follow to copy them, or tap Copy on one in the chat.'}</small></div></div>
        <div className="setting"><div><strong>Invite link</strong><small>Code <b className="code">{cult.inviteCode}</b></small></div><button className="btn btn-ghost btn-sm" onClick={onInvite}><Copy size={14} /> Copy</button></div>
        {cult.isOwner && <div className="setting"><div><strong>Visibility</strong><small>{cult.visibility === 'public' ? 'Listed in Discover and public rankings.' : 'Invite only.'}</small></div><div className="seg seg--sm"><button className={cult.visibility === 'private' ? 'on' : ''} disabled={busy} onClick={() => onVisibility('private')}>Private</button><button className={cult.visibility === 'public' ? 'on' : ''} disabled={busy} onClick={() => onVisibility('public')}>Public</button></div></div>}
        <div className="setting danger"><div><strong>Leave cult</strong><small>Pending copies are cancelled. Open ones unwind when their leader exits.</small></div>{!confirmLeave ? <button className="btn btn-danger btn-sm" onClick={() => setConfirmLeave(true)}>Leave</button> : <div className="row-gap"><button className="btn btn-ghost btn-sm" onClick={() => setConfirmLeave(false)}>Cancel</button><button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void onLeave()}>Confirm</button></div>}</div>
      </div>}
    </section>
  </aside>;
}
