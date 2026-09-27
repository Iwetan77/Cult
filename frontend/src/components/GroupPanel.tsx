'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { ArrowRight, Copy, ShieldCheck, X } from 'lucide-react';
import { getLeaderboard } from '@/lib/api';
import type { BackendConfig, ChartMarker, ChartSnapshot, ChatRoom, Clan, Leaderboard, MirrorPolicy } from '@/lib/contracts';
import { percent, signedDollars } from '@/lib/format';
import { SharedChart } from './SharedChart';

type Props = {
  room: ChatRoom; cult: Clan | null; config: BackendConfig | null; snapshot: ChartSnapshot | null;
  selected: ChartMarker | null; busy: boolean; signerPrompt: string | null; onGrantSigner: () => void;
  onFollowOn: (policy: MirrorPolicy) => Promise<void>; onFollowOff: () => Promise<void>;
  onMarket: (marketId: string) => void; onMarker: (marker: ChartMarker) => void; onOpenTrade: () => void;
  onGuideDrop: (marker: ChartMarker, kind: 'takeProfit' | 'stopLoss', price: number) => void;
  onInvite: () => void; onVisibility: (visibility: 'private' | 'public') => void;
  onLeave: () => Promise<void>; onProfile: (memberId: string) => void;
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

  return <div className="room-ranking">{error ? <p className="wallet-warning">{error}</p> : !board ? <p className="field-note">Loading rankings...</p> : board.entries.length ? board.entries.slice(0, 8).map(entry => <button key={entry.memberId} className="room-rank-row" onClick={() => onProfile(entry.memberId)}><span className="rank-number">{entry.rank}</span><span><strong>{entry.name}</strong><small>{entry.copiedTradeCount ? `+${entry.copiedTradeCount} copied · ` : ''}{entry.winRate == null ? '—' : percent(entry.winRate * 100)} win rate</small></span><b className={entry.realizedPnlUsd >= 0 ? 'positive' : 'negative'}>{signedDollars(entry.realizedPnlUsd)}</b></button>) : <p className="field-note">No verified closed trades yet.</p>}</div>;
}

export function GroupPanel({ room, cult, config, snapshot, selected, busy, signerPrompt, onGrantSigner, onFollowOn, onFollowOff, onMarket, onMarker, onOpenTrade, onGuideDrop, onInvite, onVisibility, onLeave, onProfile }: Props) {
  const [tab, setTab] = useState<'positions' | 'stats' | 'members' | 'settings'>('positions');
  const [followSheet, setFollowSheet] = useState(false);
  const [maxUsd, setMaxUsd] = useState('');
  const [balancePct, setBalancePct] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const market = snapshot?.selectedMarket;
  const markers = snapshot?.markers.filter(item => item.marketId === market?.id) ?? [];

  const openFollowSheet = () => {
    setMaxUsd(String(config?.autoFollowDefaults.maxUsdPerTrade ?? ''));
    setBalancePct(String(config?.autoFollowDefaults.balancePercentCap ?? ''));
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

  if (room.kind !== 'cult' || !cult) return <aside className="group-side"><div className="group-side-head"><span className="eyebrow">{room.kind === 'global' ? 'GLOBAL' : 'COUNTRY'}</span><h2>Leaderboard</h2></div><RoomRanking room={room} onProfile={onProfile} /></aside>;

  return <aside className="group-side">
    <div className="group-side-head"><span className="eyebrow">CULT</span><h2>{cult.name}</h2><span className="group-member-count">{cult.memberCount} members</span></div>
    <div className="follow-control"><label className="switch-row"><span><strong>Auto-follow</strong><small>Copy trades from this cult into your wallet</small></span><input type="checkbox" checked={cult.autoFollow} disabled={busy} onChange={event => { if (event.target.checked) openFollowSheet(); else void onFollowOff(); }} /></label></div>
    {cult.autoFollow && signerPrompt && <div className="group-signer-alert"><p>{signerPrompt}. Nad.fun copies cannot run until your wallet confirms the signer.</p><button className="outline full" disabled={busy} onClick={onGrantSigner}><ShieldCheck size={14} /> Approve signer</button></div>}
    {followSheet && <div className="follow-sheet"><div className="home-section-head"><h3>Set your limits</h3><button className="icon-button compact" title="Close" onClick={() => setFollowSheet(false)}><X size={14} /></button></div><label className="field-label" htmlFor="follow-usd">MAX $ PER TRADE</label><input id="follow-usd" type="number" min="1" value={maxUsd} onChange={event => setMaxUsd(event.target.value)} /><label className="field-label" htmlFor="follow-percent">MAX % OF BALANCE</label><input id="follow-percent" type="number" min="1" max="100" value={balancePct} onChange={event => setBalancePct(event.target.value)} /><button className="primary full" disabled={busy} onClick={turnOn}><ShieldCheck size={15} /> Turn on</button>{error && <p className="wallet-warning">{error}</p>}</div>}
    <div className="group-side-tabs">{([['positions', 'Positions'], ['stats', 'Cult stats'], ['members', 'Members'], ['settings', 'Settings']] as const).map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    <div className="group-side-body">
      {tab === 'positions' ? <>
        <div className="group-market"><select aria-label="Chart market" value={market?.id ?? ''} onChange={event => onMarket(event.target.value)}>{snapshot?.markets.map(item => <option key={`${item.venue}:${item.id}`} value={item.id}>{item.symbol}</option>)}</select><small>{market?.venue === 'perpl' ? 'Perpl' : 'Nad.fun'}</small></div>
        <SharedChart candles={snapshot?.candles ?? []} markers={markers} market={market ?? { venue: 'perpl', id: '', symbol: '', baseSymbol: '', quoteSymbol: 'USD', maxLeverage: 1, makerFeeBps: null, takerFeeBps: null }} selectedId={selected?.id ?? null} onSelect={onMarker} onGuideDrop={onGuideDrop} guidesDisabled={busy} />
        <div className="group-positions">{markers.length ? markers.map(marker => <button className={selected?.id === marker.id ? 'selected' : ''} key={marker.id} onClick={() => onMarker(marker)}><span>{marker.memberName}<small>{marker.origin === 'auto_mirror' ? 'Auto copy' : marker.origin === 'manual_stack' ? 'Manual stack' : 'Own trade'}</small></span><strong>{marker.pnlUsd == null ? 'Pending' : signedDollars(marker.pnlUsd)}</strong></button>) : <p className="field-note">No open positions on this market.</p>}</div>
        <button className="outline full" onClick={onOpenTrade}>Open trading chart <ArrowRight size={14} /></button>
      </> : tab === 'stats' ? <RoomRanking room={room} cultId={cult.id} onProfile={onProfile} /> : tab === 'members' ? <div className="group-members">{snapshot?.members.length ? snapshot.members.map(member => <button key={member.id} onClick={() => onProfile(member.id)}><span className="room-avatar">{member.name.slice(0, 1).toUpperCase()}</span><span><strong>{member.name}</strong><small>{member.verified ? `${member.tradeCount} own trades · ${member.winRate == null ? '—' : percent(member.winRate * 100)}` : 'Unverified'}</small></span><b>{member.realizedPnlUsd == null ? '—' : signedDollars(member.realizedPnlUsd)}</b></button>) : <p className="field-note">Member records will appear after indexer sync.</p>}</div> : <div className="group-settings">
        <button className="outline full" onClick={onInvite}><Copy size={15} /> Copy invite link</button><p className="field-note">Code: {cult.inviteCode}</p>
        {cult.isOwner && <><div className="trade-divider" /><h3>Visibility</h3><div className="funding-modes"><button className={cult.visibility === 'private' ? 'active' : ''} disabled={busy} onClick={() => onVisibility('private')}>Private</button><button className={cult.visibility === 'public' ? 'active' : ''} disabled={busy} onClick={() => onVisibility('public')}>Public</button></div></>}
        <div className="trade-divider" /><h3>Leave cult</h3>{!confirmLeave ? <button className="outline full danger-button" onClick={() => setConfirmLeave(true)}>Leave cult</button> : <div className="leave-actions"><button className="outline" onClick={() => setConfirmLeave(false)}>Cancel</button><button className="outline danger-button" disabled={busy} onClick={() => void onLeave()}>Confirm leave</button></div>}
      </div>}
    </div>
  </aside>;
}
