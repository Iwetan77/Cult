'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getAccessToken } from '@/lib/auth';
import { ArrowRight, ArrowUpRight, Camera, LogOut, Wallet } from './icons';
import { deleteAvatar, getPredictionPositions, getProfile, uploadAvatar } from '@/lib/api';
import type { ClosedTrade, Holding, PredictionClosed, PredictionPosition, Profile } from '@/lib/contracts';
import { getEvent, type PredictionOutcome } from '@/lib/polymarket';
import { EventArt, type PredictionPick } from './PredictionsBrowse';
import { percent, shortAddress, signedDollars, signedPct } from '@/lib/format';
import { CountryPicker } from './CountryPicker';
import { Avatar } from './Avatar';
import { RoomBadge } from './RoomBadge';
import { TokenLogo } from './TokenLogo';
import { PerfBars, type PerfBar } from './PerfBars';
import type { TradeSheetTarget } from './TradeSheet';
import type { AccountTab } from '@/lib/routes';

const predictionTitle = (p: PredictionPosition) => p.outcomeLabel === p.question ? p.question : `${p.outcomeLabel} · ${p.eventTitle}`;

type Props = {
  id: string; holdings: Holding[]; onCloseHolding: (holding: Holding) => void; onCountrySaved: () => Promise<unknown>; onDeposit: () => void; onWithdraw: () => void;
  onSignOut: () => void; onTrade: (target: TradeSheetTarget) => void; onAvatarSaved: () => Promise<unknown>; onRoom: (roomId: string) => void;
  tab: AccountTab; onTab: (tab: AccountTab) => void;
  predictionRevision: number; onOpenPrediction: (slug: string, pick?: PredictionPick) => void; onSellPrediction: (position: PredictionPosition, price: number) => void;
  // Live accounts: collect a resolved bet, and open the predictions balance.
  onRedeemPrediction?: (position: PredictionPosition) => void; onPredictionFunds?: () => void;
  signOutLabel?: string;
};

export type { AccountTab } from '@/lib/routes';

// Realized PnL per day, week or month (whichever gives a readable run of
// bars for how long you've traded), with the running total behind each.
const DAY = 86_400_000;
function performanceBars(trades: ClosedTrade[], now: number): PerfBar[] {
  if (!trades.length) return [];
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const days = (now - sorted[0]!.closedAt) / DAY;
  const unit = days <= 10 ? 'day' : days <= 70 ? 'week' : 'month';
  const startOf = (t: number) => {
    const d = new Date(t); d.setHours(0, 0, 0, 0);
    if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (unit === 'month') d.setDate(1);
    return d.getTime();
  };
  const next = (t: number) => { const d = new Date(t); if (unit === 'day') d.setDate(d.getDate() + 1); else if (unit === 'week') d.setDate(d.getDate() + 7); else d.setMonth(d.getMonth() + 1); return d.getTime(); };
  const starts: number[] = [];
  for (let t = startOf(sorted[0]!.closedAt); t <= now; t = next(t)) starts.push(t);
  // At least six bars so a new account still reads as a chart; at most eight.
  while (starts.length < 6) { const d = new Date(starts[0]!); if (unit === 'day') d.setDate(d.getDate() - 1); else if (unit === 'week') d.setDate(d.getDate() - 7); else d.setMonth(d.getMonth() - 1); starts.unshift(d.getTime()); }
  let total = 0, i = 0;
  const bars = starts.map((start, index) => {
    const end = next(start);
    let value = 0, count = 0, wins = 0;
    for (; i < sorted.length && sorted[i]!.closedAt < end; i++) { value += sorted[i]!.pnlUsd ?? 0; count++; if (sorted[i]!.isWin) wins++; }
    total += value;
    const d = new Date(start);
    const label = unit === 'month' ? d.toLocaleDateString('en-US', { month: 'short' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const title = unit === 'month' ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : unit === 'week' ? `Week of ${label}` : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    // Phones: just the day, with the month where it starts or changes.
    const short = unit === 'month' || index === 0 || d.getDate() <= 7 && (unit === 'week' || d.getDate() === 1) ? label : String(d.getDate());
    return { key: String(start), label, short, title, value, total, note: count ? `${count} ${count === 1 ? 'trade' : 'trades'} · ${Math.round((wins / count) * 100)}% wins` : 'No closed trades' };
  });
  return bars.slice(-8);
}

export function AccountView({ id, holdings, onCloseHolding, onCountrySaved, onDeposit, onWithdraw, onSignOut, onTrade, onAvatarSaved, onRoom, tab, onTab: setTab, predictionRevision, onOpenPrediction, onSellPrediction, onRedeemPrediction, onPredictionFunds, signOutLabel = 'Sign out' }: Props) {
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
  // Your prediction bets (open and sold), with live odds for the open ones.
  const [predictions, setPredictions] = useState<{ open: PredictionPosition[]; closed: PredictionClosed[]; redeemable: string[] }>({ open: [], closed: [], redeemable: [] });
  const [odds, setOdds] = useState<Record<string, PredictionOutcome>>({});
  useEffect(() => {
    if (id !== 'me') { setPredictions({ open: [], closed: [], redeemable: [] }); return; }
    let active = true;
    getAccessToken().then(token => token ? getPredictionPositions(token) : null)
      .then(r => { if (active && r) setPredictions({ open: r.positions, closed: r.closed, redeemable: r.redeemable ?? [] }); }).catch(() => undefined);
    return () => { active = false; };
  }, [id, predictionRevision]);
  const slugsKey = [...new Set(predictions.open.map(p => p.eventSlug))].sort().join('|');
  useEffect(() => {
    if (!slugsKey) return;
    let active = true;
    const load = () => Promise.all(slugsKey.split('|').map(slug => getEvent(slug).catch(() => null))).then(events => {
      if (!active) return;
      const next: Record<string, PredictionOutcome> = {};
      for (const event of events) for (const o of event?.outcomes ?? []) next[o.id] = o;
      setOdds(next);
    });
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [slugsKey]);

  // Your positions changed (a close, a partial close, a new trade): refresh the lists quietly.
  const holdingsKey = holdings.map(h => `${h.venue}:${h.market}:${h.sizeRaw}`).sort().join(',');
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

  const bars = useMemo(() => profile ? performanceBars(profile.closedTrades, Date.now()) : [], [profile]);

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
  // Perps/memes and predictions in one list each, newest first.
  const when = (value: number | string | null | undefined) => value == null ? 0 : typeof value === 'number' ? value : Date.parse(value) || 0;
  const openItems: ({ kind: 'trade'; at: number; trade: Profile['openTrades'][number] } | { kind: 'prediction'; at: number; p: PredictionPosition })[] = [
    ...profile.openTrades.map(trade => ({ kind: 'trade' as const, at: when(trade.openedAt), trade })),
    ...(profile.isMe ? predictions.open.map(p => ({ kind: 'prediction' as const, at: p.openedAt, p })) : []),
  ].sort((a, b) => b.at - a.at);
  const closedItems: ({ kind: 'trade'; at: number; trade: ClosedTrade } | { kind: 'prediction'; at: number; c: PredictionClosed })[] = [
    ...profile.closedTrades.map(trade => ({ kind: 'trade' as const, at: trade.closedAt, trade })),
    ...(profile.isMe ? predictions.closed.map(c => ({ kind: 'prediction' as const, at: c.closedAt, c })) : []),
  ].sort((a, b) => b.at - a.at);
  const holdingFor = (trade: Profile['openTrades'][number]) => holdings.find(item => item.market === trade.market && item.venue === trade.venue);

  return <div className="view two-col">
    <section className="view-main">
      <section className="profile-banner reveal">
        <div className="profile-id">
          {profile.isMe ? <><button className="profile-avatar" type="button" title="Change photo" disabled={photoBusy} onClick={() => fileInput.current?.click()}><Avatar name={profile.name} url={profile.avatarUrl} /><span className="profile-camera"><Camera size={14} /></span></button><input ref={fileInput} type="file" accept="image/*" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void changePhoto(file); }} /></> : <span className="profile-avatar"><Avatar name={profile.name} url={profile.avatarUrl} /></span>}
          <div className="profile-name">
            <h1>{profile.name}</h1>
            <small>{shortAddress(profile.address)} · {profile.country?.name ?? profile.country?.code ?? 'Country not set'} · since {new Date(profile.memberSince).toLocaleDateString([], { month: 'short', year: 'numeric' })}</small>
          </div>
          {profile.isMe && <div className="profile-actions">{onPredictionFunds && <button className="btn btn-glass btn-sm" onClick={onPredictionFunds}>Predictions</button>}<button className="btn btn-glass btn-sm" onClick={onWithdraw}><ArrowUpRight size={14} /> Withdraw</button><button className="btn btn-primary btn-sm" onClick={onDeposit}><Wallet size={14} /> Deposit</button></div>}
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
        {bars.length ? <PerfBars bars={bars} /> : <div className="curve-empty">Close a few trades to see your performance.</div>}
      </section>

      <section className="card" ref={tabsCard}>
        <div className="tabs">
          <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Open</button>
          <button className={tab === 'closed' ? 'on' : ''} onClick={() => setTab('closed')}>Closed</button>
          {profile.isMe && <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button>}
        </div>
        {tab === 'open' ? (openItems.length ? <div className="ttable">{openItems.map(item => {
          if (item.kind === 'prediction') {
            const p = item.p, o = odds[p.marketId];
            const now = o ? (p.side === 'yes' ? o.yesPrice : o.noPrice) : null;
            const pnl = now == null ? null : p.shares * now - p.costUsd;
            const open = () => onOpenPrediction(p.eventSlug, { outcomeId: p.marketId, side: p.side });
            return <div className="ttable-row ttable-row--open is-link" key={p.id} role="button" tabIndex={0} aria-label={`Open ${predictionTitle(p)}`}
              onClick={open} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); } }}>
              <span className="ttable-main"><EventArt event={{ image: p.image, title: p.eventTitle }} /><span><strong className="ttable-title">{predictionTitle(p)}</strong><small><span className="ttable-side-sm">{p.sideLabel} · </span>Polymarket · opened {new Date(p.openedAt).toLocaleDateString()}</small></span></span>
              <span className={`side-chip ${p.side === 'yes' ? 'long' : 'short'}`}>{p.sideLabel.toUpperCase()}</span>
              <span className={`num strong ${(pnl ?? 0) >= 0 ? 'up' : 'down'}`}>{pnl == null ? '' : signedDollars(pnl)}</span>
              {onRedeemPrediction && predictions.redeemable.includes(p.id) ? <button className="btn btn-primary btn-sm" onClick={event => { event.stopPropagation(); onRedeemPrediction(p); }}>Collect</button>
                : now != null ? <button className="btn btn-ghost btn-sm" onClick={event => { event.stopPropagation(); onSellPrediction(p, now); }}>Sell</button> : <ArrowRight size={15} className="muted" />}
            </div>;
          }
          const trade = item.trade;
          const holding = profile.isMe ? holdingFor(trade) : undefined;
          // The whole row opens the trade; Close only closes.
          const open = () => onTrade({ kind: 'trade', tradeId: trade.tradeId });
          return <div className="ttable-row ttable-row--open is-link" key={trade.tradeId} role="button" tabIndex={0} aria-label={`Open ${trade.symbol} trade`}
            onClick={open} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); } }}>
          <span className="ttable-main"><TokenLogo symbol={trade.symbol} /><span><strong>{trade.symbol}</strong><small><span className="ttable-side-sm">{trade.side === 'buy' ? 'Buy' : `${trade.side === 'long' ? 'Long' : 'Short'} ${trade.leverage}x`} · </span>{trade.venue === 'perpl' ? 'Perpl' : 'Nad.fun'} · opened {new Date(trade.openedAt).toLocaleDateString()}</small></span></span>
          <span className={`side-chip ${trade.side}`}>{trade.side.toUpperCase()}{trade.venue === 'perpl' ? ` ${trade.leverage}x` : ''}</span>
          <span className={`num strong ${(holding?.pnlAusd ?? 0) >= 0 ? 'up' : 'down'}`}>{holding?.pnlAusd != null ? signedDollars(holding.pnlAusd) : ''}</span>
          {holding ? <button className="btn btn-ghost btn-sm" onClick={event => { event.stopPropagation(); onCloseHolding(holding); }}>Close</button> : <ArrowRight size={15} className="muted" />}
        </div>; })}</div> : <div className="empty"><span>No open trades.</span></div>)
        : tab === 'closed' ? (closedItems.length ? <div className="ttable">{closedItems.map((item, index) => item.kind === 'prediction' ? (() => {
          const c = item.c, p = c.position;
          const ret = p.costUsd > 0 ? (c.pnlUsd / p.costUsd) * 100 : null;
          return <button className="ttable-row" key={`${p.id}:${c.closedAt}`} onClick={() => onOpenPrediction(p.eventSlug, { outcomeId: p.marketId, side: p.side })}>
            <span className="ttable-main"><EventArt event={{ image: p.image, title: p.eventTitle }} /><span><strong className="ttable-title">{predictionTitle(p)}</strong><small>Polymarket · {new Date(c.closedAt).toLocaleDateString()}</small></span></span>
            <span className={`side-chip ${p.side === 'yes' ? 'long' : 'short'}`}>{p.sideLabel.toUpperCase()}</span>
            <span className={`num strong ${c.pnlUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(c.pnlUsd)}</span>
            <span className={`num ${(ret ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(ret, 1)}</span>
          </button>;
        })() : (() => { const trade = item.trade; return <button className="ttable-row" key={`${trade.openTx}:${index}`} onClick={() => onTrade(trade.tradeId ? { kind: 'trade', tradeId: trade.tradeId } : { kind: 'closed', trade, member: { id: profile.id, name: profile.name, avatarUrl: profile.avatarUrl, address: profile.address } })}>
          <span className="ttable-main"><TokenLogo symbol={trade.symbol} /><span><strong>{trade.symbol}{trade.copied && <em className="copied">copied</em>}</strong><small>{trade.venue === 'perpl' ? 'Perpl' : 'Nad.fun'} · {new Date(trade.closedAt).toLocaleDateString()}</small></span></span>
          <span className={`side-chip ${trade.side}`}>{trade.side.toUpperCase()}</span>
          <span className={`num strong ${(trade.pnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{trade.pnlUsd == null ? 'Pending' : signedDollars(trade.pnlUsd)}</span>
          <span className={`num ${(trade.returnPct ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(trade.returnPct, 1)}</span>
        </button>; })())}</div> : <div className="empty"><span>No closed trades yet.</span></div>)
        : <div className="settings">
          <CountryPicker currentCode={profile.country?.code} onSaved={onCountrySaved} />
          <div className="setting"><div><strong>Profile photo</strong><small>Shown next to your trades and messages.</small></div><button className="btn btn-ghost btn-sm" disabled={photoBusy} onClick={() => fileInput.current?.click()}><Camera size={14} /> Change</button></div>
          <div className="setting danger"><div><strong>{signOutLabel}</strong><small>Your funds stay in your wallet.</small></div><button className="btn btn-ghost btn-sm" onClick={onSignOut}><LogOut size={14} /> {signOutLabel}</button></div>
        </div>}
      </section>
    </section>

    <aside className="view-side">
      <section className="card record">
        <div className="card-head"><h2>Track record</h2></div>
        <dl className="record-lines">
          <div><dt>Perps PnL</dt><dd className={`num ${record.realizedPnlPerplUsd >= 0 ? 'up' : 'down'}`}>{signedDollars(record.realizedPnlPerplUsd)}</dd></div>
          <div><dt>Meme PnL</dt><dd className="num">{record.realizedPnlMon.toLocaleString()} MON</dd></div>
          <div><dt>Win streak</dt><dd className="num">{record.streak}</dd></div>
          <div><dt>Copied trades</dt><dd className="num">{record.copied.tradeCount}</dd></div>
          <div><dt>Copied PnL</dt><dd className={`num ${(record.copied.realizedPnlUsd ?? 0) >= 0 ? 'up' : 'down'}`}>{record.copied.realizedPnlUsd == null ? '—' : signedDollars(record.copied.realizedPnlUsd)}</dd></div>
        </dl>
      </section>
      <section className="card">
        <div className="card-head"><h2>Cults</h2></div>
        {profile.cults.length ? <div className="side-rooms">{profile.cults.map(cult => <button key={cult.id} onClick={() => onRoom(`cult:${cult.id}`)}><RoomBadge icon={cult.name[0]!.toUpperCase()} kind="cult" /><span><strong>{cult.name}</strong><small>{cult.visibility === 'public' ? 'Public' : 'Private'}</small></span><ArrowRight size={14} /></button>)}</div> : <div className="empty compact"><span>Not in any cult yet.</span></div>}
      </section>
    </aside>
  </div>;
}
