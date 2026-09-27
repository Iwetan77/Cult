'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { getProfile } from '@/lib/api';
import type { Profile } from '@/lib/contracts';
import { percent, shortAddress, signedDollars } from '@/lib/format';
import { CountryPicker } from './CountryPicker';
import type { TradeSheetTarget } from './TradeSheet';

type Props = {
  id: string; onCountrySaved: () => Promise<unknown>; onDeposit: () => void;
  onPerplSetup: () => void; onSignOut: () => void; onTrade: (target: TradeSheetTarget) => void;
};

export function AccountView({ id, onCountrySaved, onDeposit, onPerplSetup, onSignOut, onTrade }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
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

  if (error) return <main className={`full-workspace profile-screen ${id === 'me' ? 'own-profile' : ''}`}><p className="wallet-warning">{error}</p></main>;
  if (!profile) return <main className={`full-workspace profile-screen ${id === 'me' ? 'own-profile' : ''}`}><p className="field-note">Loading profile...</p></main>;
  const record = profile.record;

  return <main className={`full-workspace profile-screen ${id === 'me' ? 'own-profile' : ''}`}>
    <header className="profile-head"><span className="room-avatar">{profile.name.slice(0, 1).toUpperCase()}</span><div><span className="eyebrow">{profile.isMe ? 'ACCOUNT' : 'TRADER PROFILE'}</span><h1>{profile.name}</h1><p>{shortAddress(profile.address)} · {profile.country?.name ?? 'Country not set'} · Member since {new Date(profile.memberSince).toLocaleDateString()}</p></div></header>
    <div className="profile-content">
      <section className="profile-record"><div className="home-section-head"><h2>Track record</h2>{record.verified ? <ShieldCheck size={16} className="positive" /> : <span className="unverified">UNVERIFIED</span>}</div><div className="record-grid">
        <div><span>REALIZED PNL</span><strong className={(record.realizedPnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{record.realizedPnlUsd == null ? '—' : signedDollars(record.realizedPnlUsd)}</strong></div>
        <div><span>WIN RATE</span><strong>{record.winRate == null ? '—' : percent(record.winRate * 100)}</strong></div>
        <div><span>STREAK</span><strong>{record.streak}</strong></div>
        <div><span>AVG WIN</span><strong>{record.avgWinPct == null ? '—' : percent(record.avgWinPct)}</strong></div>
      </div><p className="field-note">{record.tradeCount} own trades · +{record.copied.tradeCount} copied</p></section>
      <section className="profile-trades"><div className="home-section-head"><h2>Positions</h2><div className="funding-modes"><button className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Open</button><button className={tab === 'closed' ? 'active' : ''} onClick={() => setTab('closed')}>Closed</button></div></div>
        {tab === 'open' ? profile.openTrades.length ? profile.openTrades.map(trade => <button className="profile-trade" key={trade.tradeId} onClick={() => onTrade({ kind: 'trade', tradeId: trade.tradeId })}><span><strong>{trade.symbol}</strong><small>{trade.venue === 'perpl' ? 'Perpl' : 'Nad.fun'} · {trade.side.toUpperCase()} · {trade.leverage}x</small></span><ArrowRight size={15} /></button>) : <p className="field-note">No open trades.</p> : profile.closedTrades.length ? profile.closedTrades.map((trade, index) => <button className="profile-trade" key={`${trade.openTx}:${index}`} onClick={() => onTrade(trade.tradeId ? { kind: 'trade', tradeId: trade.tradeId } : { kind: 'closed', trade, member: { id: profile.id, name: profile.name, avatarUrl: profile.avatarUrl, address: profile.address } })}><span><strong>{trade.symbol} {trade.copied && <small className="copied-label">copied</small>}</strong><small>{trade.venue === 'perpl' ? 'Perpl' : 'Nad.fun'} · {new Date(trade.closedAt).toLocaleDateString()}</small></span><span className={`profile-trade-result ${(trade.pnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}`}>{trade.pnlUsd == null ? 'Pending' : signedDollars(trade.pnlUsd)}<small>{trade.returnPct == null ? '—' : percent(trade.returnPct)}</small></span></button>) : <p className="field-note">No closed trades yet.</p>}
      </section>
      {profile.isMe && <section className="profile-settings"><div className="home-section-head"><h2>Settings</h2></div><CountryPicker currentCode={profile.country?.code} onSaved={onCountrySaved} /><div className="profile-actions"><button className="outline" onClick={onDeposit}>Deposit</button><button className="outline" onClick={onPerplSetup}>Perpl setup</button><button className="outline" onClick={onSignOut}>Sign out</button></div></section>}
    </div>
  </main>;
}
