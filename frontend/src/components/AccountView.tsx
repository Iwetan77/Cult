'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getAccessToken } from '@/lib/auth';
import { ArrowRight, ArrowUpRight, Camera, LogOut, ShieldCheck, Wallet } from 'lucide-react';
import { deleteAvatar, getProfile, uploadAvatar } from '@/lib/api';
import type { Holding, Profile } from '@/lib/contracts';
import { percent, shortAddress, signedDollars, signedPct } from '@/lib/format';
import { CountryPicker } from './CountryPicker';
import { Avatar } from './Avatar';
import { RoomBadge } from './RoomBadge';
import { TokenLogo } from './TokenLogo';
import type { TradeSheetTarget } from './TradeSheet';

type Props = {
  id: string; holdings: Holding[]; onCloseHolding: (holding: Holding) => void; onCountrySaved: () => Promise<unknown>; onDeposit: () => void; onWithdraw: () => void;
  onSignOut: () => void; onTrade: (target: TradeSheetTarget) => void; onAvatarSaved: () => Promise<unknown>; onRoom: (roomId: string) => void;
  tab: AccountTab; onTab: (tab: AccountTab) => void;
  signOutLabel?: string;
};

export type AccountTab = 'open' | 'closed' | 'settings';

// Cumulative realized PnL across closed trades, as a soft area line.
function PnlCurve({ points }: { points: { t: number; v: number }[] }) {
  if (points.length < 2) return <div className="curve-empty">Close a few trades to draw your curve.</div>;
  const w = 600, h = 160, pad = 8;
  const ts = points.map(p => p.t), vs = points.map(p => p.v);
  const minT = Math.min(...ts), maxT = Math.max(...ts), minV = Math.min(0, ...vs), maxV = Math.max(0, ...vs);
  const x = (t: number) => pad + ((t - minT) / Math.max(1, maxT - minT)) * (w - pad * 2);
  const y = (v: number) => pad + (1 - (v - minV) / Math.max(1e-9, maxV - minV)) * (h - pad * 2);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const up = vs.at(-1)! >= 0;
  return <svg className={`curve ${up ? 'is-up' : 'is-down'}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="curve-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
    <line x1={pad} x2={w - pad} y1={y(0)} y2={y(0)} className="curve-zero" />
    <path d={`${line} L${x(maxT)},${h} L${x(minT)},${h} Z`} fill="url(#curve-fill)" />
    <path d={line} className="curve-line" />
  </svg>;
}

export function AccountView({ id, holdings, onCloseHolding, onCountrySaved, onDeposit, onWithdraw, onSignOut, onTrade, onAvatarSaved, onRoom, tab, onTab: setTab, signOutLabel = 'Sign out' }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tabsCard = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    setProfile(null);
    setError(null);
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to see this profile.');
      return getProfile(token, id);
    }).then(value => { if (active) setProfile(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Profile unavailable.'); });
    return () => { active = false; };
  }, [id]);
  // Your positions changed (a close, a new trade): refresh the lists quietly.
  const holdingsKey = holdings.map(h => `${h.venue}:${h.market}`).sort().join(',');
  const firstHoldings = useRef(holdingsKey);
  useEffect(() => {
    if (id !== 'me' || holdingsKey === firstHoldings.current) return;
    firstHoldings.current = holdingsKey;
    let active = true;
    getAccessToken().then(token => token ? getProfile(token, id) : null).then(value => { if (active && value) setProfile(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [id, holdingsKey]);
  // Settings sits below the fold; bring it up when it is picked (e.g. from the side panel).
  const loaded = profile != null;
  useEffect(() => {
    const card = tabsCard.current;
    if (tab !== 'settings' || !loaded || !card) return;
    const top = card.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.5) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [tab, loaded]);

  const curve = useMemo(() => {
    if (!profile) return [];
    let sum = 0;
    const sorted = [...profile.closedTrades].sort((a, b) => a.closedAt - b.closedAt);
    return [{ t: (sorted[0]?.openedAt ?? sorted[0]?.closedAt ?? 0) - 3_600_000, v: 0 }, ...sorted.map(trade => ({ t: trade.closedAt, v: (sum += trade.pnlUsd ?? 0) }))];
  }, [profile]);

  const changePhoto = async (file: File) => {
    setPhotoBusy(true); setError(null);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image.')); };
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Photo editing is unavailable in this browser.');
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 256, 256);
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to update your photo.');
      await uploadAvatar(token, canvas.toDataURL('image/jpeg', 0.85));
      setProfile(await getProfile(token, 'me'));
      await onAvatarSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Photo upload failed.'); }
    finally { setPhotoBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  const removePhoto = async () => {
    setPhotoBusy(true); setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to remove your photo.');
      await deleteAvatar(token);
      setProfile(await getProfile(token, 'me'));
      await onAvatarSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Photo removal failed.'); }
    finally { setPhotoBusy(false); }
  };

  if (error && !profile) return <div className="view one-col"><section className="view-main"><p className="notice-line">{error}</p></section></div>;
  if (!profile) return <div className="view one-col"><section className="view-main"><div className="skel skel-banner" /><div className="skel skel-chart" /></section></div>;
  const record = profile.record;
  const holdingFor = (trade: Profile['openTrades'][number]) => holdings.find(item => item.market === trade.market && item.venue === trade.venue);

  return <div className="view two-col">
    <section className="view-main">
      <section className="profile-banner reveal">
        <div className="profile-id">
          {profile.isMe ? <><button className="profile-avatar" type="button" title="Change photo" disabled={photoBusy} onClick={() => fileInput.current?.click()}><Avatar name={profile.name} url={profile.avatarUrl} /><span className="profile-camera"><Camera size={14} /></span></button><input ref={fileInput} type="file" accept="image/*" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void changePhoto(file); }} /></> : <span className="profile-avatar"><Avatar name={profile.name} url={profile.avatarUrl} /></span>}
          <div className="profile-name">
            <span className="eyebrow">{profile.isMe ? 'Your account' : 'Trader'}{record.verified && <><ShieldCheck size={12} /> Verified</>}</span>
            <h1>{profile.name}</h1>
            <small>{shortAddress(profile.address)} · {profile.country?.name ?? profile.country?.code ?? 'Country not set'} · since {new Date(profile.memberSince).toLocaleDateString([], { month: 'short', year: 'numeric' })}</small>
          </div>
          {profile.isMe && <div className="profile-actions"><button className="btn btn-glass btn-sm" onClick={onWithdraw}><ArrowUpRight size={14} /> Withdraw</button><button className="btn btn-primary btn-sm" onClick={onDeposit}><Wallet size={14} /> Deposit</button></div>}
        </div>
        {profile.isMe && (profile.avatarUrl || photoBusy || error) && <div className="profile-photo-note">{profile.avatarUrl && <button className="link" disabled={photoBusy} onClick={() => void removePhoto()}>Remove photo</button>}{photoBusy && <span>Updating photo…</span>}{error && <span className="down">{error}</span>}</div>}
      </section>

      <div className="stat-strip">
        <div className="stat"><span>Realized PnL</span><strong className={`num ${(record.realizedPnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{record.realizedPnlUsd == null ? '—' : signedDollars(record.realizedPnlUsd)}</strong></div>
        <div className="stat"><span>Win rate</span><strong className="num">{record.winRate == null ? '—' : percent(record.winRate * 100)}</strong></div>
        <div className="stat"><span>Trades</span><strong className="num">{record.tradeCount}<small> +{record.copied.tradeCount} copied</small></strong></div>
        <div className="stat"><span>Avg win</span><strong className="num">{record.avgWinPct == null ? '—' : `+${record.avgWinPct.toFixed(1)}%`}</strong></div>
      </div>

      <section className="card">
        <div className="card-head"><h2>Performance</h2><span className="count">Realized, closed trades</span></div>
        <PnlCurve points={curve} />
      </section>

      <section className="card" ref={tabsCard}>
        <div className="tabs">
          <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Open<b>{profile.openTrades.length}</b></button>
          <button className={tab === 'closed' ? 'on' : ''} onClick={() => setTab('closed')}>Closed<b>{profile.closedTrades.length}</b></button>
          {profile.isMe && <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button>}
        </div>
        {tab === 'open' ? (profile.openTrades.length ? <div className="ttable">{profile.openTrades.map(trade => {
          const holding = profile.isMe ? holdingFor(trade) : undefined;
          // The whole row opens the trade; Close only closes.
          const open = () => onTrade({ kind: 'trade', tradeId: trade.tradeId });
          return <div className="ttable-row is-link" key={trade.tradeId} role="button" tabIndex={0} aria-label={`Open ${trade.symbol} trade`}
            onClick={open} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); } }}>
          <span className="ttable-main"><TokenLogo symbol={trade.symbol} /><span><strong>{trade.symbol}</strong><small>{trade.venue === 'perpl' ? 'Perpl' : 'Nad.fun'} · opened {new Date(trade.openedAt).toLocaleDateString()}</small></span></span>
          <span className={`side-chip ${trade.side}`}>{trade.side.toUpperCase()}{trade.venue === 'perpl' ? ` ${trade.leverage}x` : ''}</span>
          <span className={`num strong ${(holding?.pnlAusd ?? 0) >= 0 ? 'up' : 'down'}`}>{holding?.pnlAusd != null ? signedDollars(holding.pnlAusd) : ''}</span>
          {holding ? <button className="btn btn-ghost btn-sm" onClick={event => { event.stopPropagation(); onCloseHolding(holding); }}>Close</button> : <ArrowRight size={15} className="muted" />}
        </div>; })}</div> : <div className="empty"><span>No open trades.</span></div>)
        : tab === 'closed' ? (profile.closedTrades.length ? <div className="ttable">{profile.closedTrades.map((trade, index) => <button className="ttable-row" key={`${trade.openTx}:${index}`} onClick={() => onTrade(trade.tradeId ? { kind: 'trade', tradeId: trade.tradeId } : { kind: 'closed', trade, member: { id: profile.id, name: profile.name, avatarUrl: profile.avatarUrl, address: profile.address } })}>
          <span className="ttable-main"><TokenLogo symbol={trade.symbol} /><span><strong>{trade.symbol}{trade.copied && <em className="copied">copied</em>}</strong><small>{trade.venue === 'perpl' ? 'Perpl' : 'Nad.fun'} · {new Date(trade.closedAt).toLocaleDateString()}</small></span></span>
          <span className={`side-chip ${trade.side}`}>{trade.side.toUpperCase()}</span>
          <span className={`num strong ${(trade.pnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{trade.pnlUsd == null ? 'Pending' : signedDollars(trade.pnlUsd)}</span>
          <span className={`num ${(trade.returnPct ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(trade.returnPct, 1)}</span>
        </button>)}</div> : <div className="empty"><span>No closed trades yet.</span></div>)
        : <div className="settings">
          <CountryPicker currentCode={profile.country?.code} onSaved={onCountrySaved} />
          <div className="setting"><div><strong>Profile photo</strong><small>Shown next to your trades and messages.</small></div><button className="btn btn-ghost btn-sm" disabled={photoBusy} onClick={() => fileInput.current?.click()}><Camera size={14} /> Change</button></div>
          <div className="setting danger"><div><strong>{signOutLabel}</strong><small>Your funds stay in your wallet.</small></div><button className="btn btn-ghost btn-sm" onClick={onSignOut}><LogOut size={14} /> {signOutLabel}</button></div>
        </div>}
      </section>
    </section>

    <aside className="view-side">
      <section className="card record">
        <div className="card-head"><h2>Track record</h2>{record.verified ? <span className="verified"><ShieldCheck size={14} /> Verified</span> : <span className="count">Unverified</span>}</div>
        <dl className="record-lines">
          <div><dt>Perps PnL</dt><dd className={`num ${record.realizedPnlPerplUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(record.realizedPnlPerplUsd)}</dd></div>
          <div><dt>Meme PnL</dt><dd className="num">{record.realizedPnlMon.toLocaleString()} MON</dd></div>
          <div><dt>Win streak</dt><dd className="num">{record.streak}</dd></div>
          <div><dt>Copied trades</dt><dd className="num">{record.copied.tradeCount}</dd></div>
          <div><dt>Copied PnL</dt><dd className={`num ${(record.copied.realizedPnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{record.copied.realizedPnlUsd == null ? '—' : signedDollars(record.copied.realizedPnlUsd)}</dd></div>
        </dl>
      </section>
      <section className="card">
        <div className="card-head"><h2>Cults</h2><span className="count">{profile.cults.length}</span></div>
        {profile.cults.length ? <div className="side-rooms">{profile.cults.map(cult => <button key={cult.id} onClick={() => onRoom(`cult:${cult.id}`)}><RoomBadge icon={cult.name[0]!.toUpperCase()} kind="cult" /><span><strong>{cult.name}</strong><small>{cult.visibility === 'public' ? 'Public' : 'Private'}</small></span><ArrowRight size={14} /></button>)}</div> : <div className="empty compact"><span>Not in any cult yet.</span></div>}
      </section>
    </aside>
  </div>;
}
