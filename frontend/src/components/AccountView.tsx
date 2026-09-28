'use client';

import { useEffect, useRef, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { ArrowRight, Camera, ShieldCheck } from 'lucide-react';
import { deleteAvatar, getProfile, uploadAvatar } from '@/lib/api';
import type { Holding, Profile } from '@/lib/contracts';
import { percent, shortAddress, signedDollars } from '@/lib/format';
import { CountryPicker } from './CountryPicker';
import { Avatar } from './Avatar';
import type { TradeSheetTarget } from './TradeSheet';

type Props = {
  id: string; holdings: Holding[]; onCloseHolding: (holding: Holding) => void; onCountrySaved: () => Promise<unknown>; onDeposit: () => void;
  onSignOut: () => void; onTrade: (target: TradeSheetTarget) => void; onAvatarSaved: () => Promise<unknown>;
};

export function AccountView({ id, holdings, onCloseHolding, onCountrySaved, onDeposit, onSignOut, onTrade, onAvatarSaved }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [error, setError] = useState<string | null>(null);
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

  if (error && !profile) return <main className={`full-workspace profile-screen ${id === 'me' ? 'own-profile' : ''}`}><p className="wallet-warning">{error}</p></main>;
  if (!profile) return <main className={`full-workspace profile-screen ${id === 'me' ? 'own-profile' : ''}`}><p className="field-note">Loading profile...</p></main>;
  const record = profile.record;

  return <main className={`full-workspace profile-screen ${id === 'me' ? 'own-profile' : ''}`}>
    <header className="profile-head"><div className="profile-avatar-wrap">{profile.isMe ? <><button className="profile-avatar-button" type="button" title="Change photo" disabled={photoBusy} onClick={() => fileInput.current?.click()}><Avatar name={profile.name} url={profile.avatarUrl} /><Camera size={14} className="profile-camera" /></button><input ref={fileInput} type="file" accept="image/*" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void changePhoto(file); }} /></> : <Avatar name={profile.name} url={profile.avatarUrl} />}</div><div><span className="eyebrow">{profile.isMe ? 'ACCOUNT' : 'TRADER PROFILE'}</span><h1>{profile.name}</h1><p>{shortAddress(profile.address)} · {profile.country?.name ?? 'Country not set'} · Member since {new Date(profile.memberSince).toLocaleDateString()}</p></div></header>
    {profile.isMe && <div className="profile-photo-actions">{profile.avatarUrl && <button className="text-link" disabled={photoBusy} onClick={() => void removePhoto()}>Remove photo</button>}{photoBusy && <span className="field-note">Updating photo...</span>}{error && <span className="wallet-warning">{error}</span>}</div>}
    <div className="profile-content">
      <section className="profile-record"><div className="home-section-head"><h2>Track record</h2>{record.verified ? <ShieldCheck size={16} className="positive" /> : <span className="unverified">UNVERIFIED</span>}</div><div className="record-grid">
        <div><span>REALIZED PNL</span><strong className={(record.realizedPnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{record.realizedPnlUsd == null ? '—' : signedDollars(record.realizedPnlUsd)}</strong></div>
        <div><span>WIN RATE</span><strong>{record.winRate == null ? '—' : percent(record.winRate * 100)}</strong></div>
        <div><span>STREAK</span><strong>{record.streak}</strong></div>
        <div><span>AVG WIN</span><strong>{record.avgWinPct == null ? '—' : percent(record.avgWinPct)}</strong></div>
      </div><p className="field-note">{record.tradeCount} own trades · +{record.copied.tradeCount} copied</p></section>
      <section className="profile-trades"><div className="home-section-head"><h2>Positions</h2><div className="funding-modes"><button className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Open</button><button className={tab === 'closed' ? 'active' : ''} onClick={() => setTab('closed')}>Closed</button></div></div>
        {tab === 'open' ? profile.openTrades.length ? profile.openTrades.map(trade => <div className="profile-trade" key={trade.tradeId}><button className="profile-trade-open" onClick={() => onTrade({ kind: 'trade', tradeId: trade.tradeId })}><span><strong>{trade.symbol}</strong><small>{trade.venue === 'perpl' ? 'Perpl' : 'Nad.fun'} · {trade.side.toUpperCase()} · {trade.leverage}x</small></span><ArrowRight size={15} /></button>{profile.isMe && holdings.find(item => item.market === trade.market && item.venue === trade.venue) && <button className="outline" onClick={() => onCloseHolding(holdings.find(item => item.market === trade.market && item.venue === trade.venue)!)}>Close</button>}</div>) : <p className="field-note">No open trades.</p> : profile.closedTrades.length ? profile.closedTrades.map((trade, index) => <button className="profile-trade" key={`${trade.openTx}:${index}`} onClick={() => onTrade(trade.tradeId ? { kind: 'trade', tradeId: trade.tradeId } : { kind: 'closed', trade, member: { id: profile.id, name: profile.name, avatarUrl: profile.avatarUrl, address: profile.address } })}><span><strong>{trade.symbol} {trade.copied && <small className="copied-label">copied</small>}</strong><small>{trade.venue === 'perpl' ? 'Perpl' : 'Nad.fun'} · {new Date(trade.closedAt).toLocaleDateString()}</small></span><span className={`profile-trade-result ${(trade.pnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}`}>{trade.pnlUsd == null ? 'Pending' : signedDollars(trade.pnlUsd)}<small>{trade.returnPct == null ? '—' : percent(trade.returnPct)}</small></span></button>) : <p className="field-note">No closed trades yet.</p>}
      </section>
      {profile.isMe && <section className="profile-settings"><div className="home-section-head"><h2>Settings</h2></div><CountryPicker currentCode={profile.country?.code} onSaved={onCountrySaved} /><div className="profile-actions"><button className="outline" onClick={onDeposit}>Deposit</button><button className="outline" onClick={onSignOut}>Sign out</button></div></section>}
    </div>
  </main>;
}
