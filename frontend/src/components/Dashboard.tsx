'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAccessToken, useFundWallet, usePrivy, useSendTransaction, useSignMessage, useWallets } from '@privy-io/react-auth';
import { monad } from 'viem/chains';
import { ArrowDownToLine, ArrowRight, Copy, ExternalLink, Link2, LogOut, Plus, RefreshCw, ShieldCheck, Wallet, X } from 'lucide-react';
import { confirmFunding, confirmStack, createClan, createShare, enrollVenue, getChart, getEnrollmentChallenge, getJoinChallenge, getMe, joinClan, prepareFunding, quoteStack, skipAutoMirror } from '@/lib/api';
import type { ChartMarker, ChartSnapshot, Me, MirrorPolicy, Venue, WalletAction } from '@/lib/contracts';
import { percent, shortAddress, signedUsd, usd } from '@/lib/format';
import { SharedChart } from './SharedChart';

const defaultPolicy: MirrorPolicy = { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 100 };
const venueName = (venue: Venue) => venue === 'perpl' ? 'Perpl' : 'Nad.fun';
const originName = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? 'Auto mirrored' : origin === 'manual_stack' ? 'Manual stack' : 'Clan position';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';

export function Dashboard() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { sendTransaction } = useSendTransaction();
  const { fundWallet } = useFundWallet();
  const wallet = wallets.find(item => item.walletClientType === 'privy') ?? wallets[0];
  const [me, setMe] = useState<Me | null>(null);
  const [clanId, setClanId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChartSnapshot | null>(null);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [policy, setPolicy] = useState<MirrorPolicy>(defaultPolicy);
  const [stackUsd, setStackUsd] = useState('50');
  const [fundUsd, setFundUsd] = useState('100');
  const [shareWithClan, setShareWithClan] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [panel, setPanel] = useState<'positions' | 'members' | 'wallet'>('positions');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [now, setNow] = useState(Date.now());
  const clan = me?.clans.find(item => item.id === clanId) ?? snapshot?.clan;
  const selected = snapshot?.markers.find(item => item.id === selectedId) ?? null;
  const market = snapshot?.selectedMarket;
  const visibleMarkers = useMemo(() => snapshot?.markers.filter(item => item.marketId === market?.id && item.venue === market?.venue) ?? [], [snapshot, market]);

  const token = async () => {
    const value = await getAccessToken();
    if (!value) throw new Error('Sign in again to continue.');
    return value;
  };
  const loadMe = useCallback(async () => {
    const result = await getMe(await token());
    setMe(result);
    setClanId(current => current ?? result.clans[0]?.id ?? null);
    return result;
  }, []);
  const loadChart = useCallback(async (id: string, market?: string) => {
    const result = await getChart(await token(), id, market);
    setSnapshot(result);
    setMarketId(result.selectedMarket.id);
    setLastRefresh(new Date());
  }, []);
  useEffect(() => {
    if (!authenticated || !wallet) return;
    let active = true;
    loadMe().catch(err => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [authenticated, wallet, loadMe]);
  useEffect(() => {
    if (!authenticated || !clanId) return;
    let active = true;
    const refresh = () => loadChart(clanId, marketId ?? undefined).catch(err => { if (active) setError(errorText(err)); });
    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [authenticated, clanId, marketId, loadChart]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('invite');
    if (code) setInviteCode(code);
  }, []);
  const perform = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError(null); setNotice(null);
    try { await action(); } catch (err) { setError(errorText(err)); } finally { setBusy(null); }
  };
  const sign = async (message: string) => {
    if (!wallet) throw new Error('Connect your wallet first.');
    const result = await signMessage({ message }, { address: wallet.address, uiOptions: { title: 'Authorize your trading wallet' } });
    return result.signature;
  };
  const transact = async (action: WalletAction) => {
    if (!wallet) throw new Error('Connect your wallet first.');
    if (action.chainId !== monad.id) throw new Error('This action is not on Monad.');
    await wallet.switchChain(action.chainId);
    const result = await sendTransaction({ to: action.to, data: action.data, value: BigInt(action.value ?? '0x0') }, { address: wallet.address });
    return result.hash;
  };
  const create = () => perform('create', async () => {
    if (!name.trim()) throw new Error('Name your clan first.');
    const result = await createClan(await token(), name.trim());
    await loadMe(); setClanId(result.id); setNotice('Clan created. Share your invite privately.');
  });
  const join = () => perform('join', async () => {
    if (!inviteCode.trim()) throw new Error('Enter an invite code.');
    if (policy.enabled && (!Number.isFinite(policy.balancePercentCap) || policy.balancePercentCap <= 0 || policy.balancePercentCap > 100 || !Number.isFinite(policy.maxUsdPerTrade) || policy.maxUsdPerTrade <= 0)) throw new Error('Enter valid mirror limits.');
    const auth = await token();
    const challenge = await getJoinChallenge(auth, inviteCode.trim());
    const signature = await sign(challenge.message);
    const joined = await joinClan(auth, inviteCode.trim(), policy, challenge.challengeId, signature);
    await loadMe(); setClanId(joined.id); setNotice('Joined. Your wallet and mirror limits are authorized.');
    window.history.replaceState({}, '', '/');
  });
  const fund = () => perform('fund', async () => {
    if (!clanId || !wallet) throw new Error('Select a clan and wallet first.');
    const amount = Number(fundUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid USDC amount.');
    const auth = await token();
    const plan = await prepareFunding(auth, clanId, fundUsd);
    if (Number(me?.usdcBalance ?? 0) < Number(plan.requiredUsdc)) {
      await fundWallet({ address: wallet.address, options: { chain: monad, asset: 'USDC', amount: plan.requiredUsdc, defaultFundingMethod: 'card' } });
      setNotice('Complete your USDC purchase, then press Fund account again once it arrives.');
      return;
    }
    const hashes: string[] = [];
    for (const action of plan.actions) hashes.push(await transact(action));
    await confirmFunding(auth, clanId, hashes);
    await loadMe(); setNotice('USDC funding submitted. Your account will update after confirmation.');
  });
  const enroll = (venue: Venue) => perform(`enroll-${venue}`, async () => {
    const auth = await token();
    const challenge = await getEnrollmentChallenge(auth, venue);
    const signature = await sign(challenge.message);
    await enrollVenue(auth, venue, challenge.challengeId, signature);
    setNotice(`${venueName(venue)} trading key enrolled.`);
  });
  const skip = () => perform('skip', async () => {
    if (!clanId || !selected || selected.origin !== 'auto_mirror' || selected.mirrorStatus !== 'pending' || !selected.skipUntil || Date.parse(selected.skipUntil) <= Date.now()) throw new Error('The skip window has closed.');
    await skipAutoMirror(await token(), clanId, selected.id);
    await loadChart(clanId, marketId ?? undefined);
    setNotice('This automatic mirror was skipped.');
  });
  const stack = () => perform('stack', async () => {
    if (!clanId || !selected) throw new Error('Select a clan position first.');
    if (selected.isMine) throw new Error('Choose a clan-mate position to stack.');
    const amount = Number(stackUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.');
    const auth = await token();
    const quote = await quoteStack(auth, clanId, selected.id, amount);
    if (quote.venue !== selected.venue || quote.marketId !== selected.marketId) throw new Error('Stack quote does not match the selected market.');
    if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error('Stack quote expired. Try again.');
    const hash = await transact(quote.action);
    await confirmStack(auth, clanId, quote.id, hash);
    await loadChart(clanId, marketId ?? undefined);
    setNotice('Manual stack submitted. It will appear separately from auto mirrors.');
  });
  const share = () => perform('share', async () => {
    if (!selected?.isMine) throw new Error('Select one of your own trades.');
    const result = await createShare(await token(), selected.id, shareWithClan);
    setShareUrl(`${window.location.origin}/share/${encodeURIComponent(result.id)}`); setNotice('Public result link created.');
  });
  const copyInvite = async () => {
    if (!clan) return;
    await navigator.clipboard.writeText(`${window.location.origin}/?invite=${encodeURIComponent(clan.inviteCode)}`);
    setNotice('Invite link copied.');
  };

  if (!ready) return <main className="config-state"><div className="brand">CULT<span className="brand-dot">.</span></div><p>Opening wallet…</p></main>;
  if (!authenticated) return <main className="login-screen"><div className="login-brand">CULT<span>.</span></div><div className="login-main"><p className="eyebrow">PRIVATE CLANS / MONAD</p><h1>Trade together.<br />Own every move.</h1><p>One chart for your clan’s live positions across Perpl and Nad.fun. Your wallet, your funds, your trades.</p><button className="primary large" onClick={login}>Enter with your wallet <ArrowRight size={17} /></button></div><div className="login-foot">INVITE ONLY <span>•</span> NO SHARED CUSTODY</div></main>;
  if (!wallet) return <main className="config-state"><div className="brand">CULT<span className="brand-dot">.</span></div><h1>Wallet setup</h1><p>Finish creating a wallet in Privy to join a clan.</p><button className="primary" onClick={login}>Open wallet setup</button></main>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand">CULT<span className="brand-dot">.</span></div><div className="topbar-divider" /><span className="topbar-caption">PRIVATE TRADING CLANS</span><div className="topbar-right"><span className="network-pill"><i /> MONAD</span><button className="wallet-pill" onClick={() => setPanel('wallet')}><Wallet size={15} /> {shortAddress(wallet.address)}</button><button className="icon-button" title="Sign out" onClick={logout}><LogOut size={16} /></button></div></header>
    <div className="workspace"><aside className="rail"><div className="rail-heading">YOUR CLANS <button className="icon-button compact" title="Create or join a clan" onClick={() => setClanId(null)}><Plus size={15} /></button></div><div className="clan-list">{me?.clans.map(item => <button key={item.id} className={`clan-item ${item.id === clanId ? 'active' : ''}`} onClick={() => { setClanId(item.id); setSnapshot(null); setSelectedId(null); }}><span className="clan-avatar">{item.name.slice(0, 1).toUpperCase()}</span><span className="clan-name">{item.name}</span><span className="clan-count">{item.memberCount}</span></button>)}</div><div className="rail-footer"><span className="tiny-label">SIGNED IN AS</span><strong>{me?.name ?? shortAddress(wallet.address)}</strong><span>{shortAddress(wallet.address)}</span></div></aside>
    {!clanId ? <main className="setup-main"><div className="setup-header"><p className="eyebrow">GET STARTED</p><h1>Find your circle.</h1><p>Clans are private. Create one or join with an invite.</p></div><div className="setup-grid"><section className="setup-section"><div className="section-number">01 / CREATE</div><h2>Start a clan</h2><label className="field-label" htmlFor="clan-name">CLAN NAME</label><input id="clan-name" value={name} onChange={event => setName(event.target.value)} maxLength={36} placeholder="Name your circle" /><button className="primary full" disabled={!!busy} onClick={create}>Create clan <ArrowRight size={16} /></button></section><section className="setup-section"><div className="section-number">02 / JOIN</div><h2>Use an invite</h2><label className="field-label" htmlFor="invite-code">INVITE CODE</label><input id="invite-code" value={inviteCode} onChange={event => setInviteCode(event.target.value)} placeholder="Paste code or link" /><div className="policy-heading"><ShieldCheck size={17} /><strong>Auto-mirror limits</strong></div><p className="field-note">Joining authorizes your wallet to mirror clan trades within these limits. You fund and hold your own positions.</p><label className="switch-row"><span>Auto mirror</span><input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({ ...policy, enabled: event.target.checked })} /></label><div className="policy-fields"><label><span className="field-label">UP TO % OF BALANCE</span><input type="number" min="1" max="100" value={policy.balancePercentCap} disabled={!policy.enabled} onChange={event => setPolicy({ ...policy, balancePercentCap: Number(event.target.value) })} /></label><label><span className="field-label">MAX USD PER TRADE</span><input type="number" min="1" value={policy.maxUsdPerTrade} disabled={!policy.enabled} onChange={event => setPolicy({ ...policy, maxUsdPerTrade: Number(event.target.value) })} /></label></div><button className="primary full" disabled={!!busy} onClick={join}>Sign & join clan <ArrowRight size={16} /></button></section></div></main> : <main className="main"><div className="main-head"><div><div className="eyebrow">CLAN / {clan?.memberCount ?? 0} MEMBERS</div><h1>{clan?.name ?? 'Clan'}</h1></div><button className="outline" onClick={copyInvite}><Link2 size={15} /> Invite</button></div><div className="market-head"><div className="market-tabs">{snapshot?.markets.map(item => <button key={`${item.venue}:${item.id}`} className={item.id === market?.id && item.venue === market.venue ? 'active' : ''} onClick={() => { setMarketId(item.id); setSelectedId(null); }}><span>{item.symbol}</span><small>{venueName(item.venue)}</small></button>)}</div><button className="icon-button" title="Refresh chart" onClick={() => loadChart(clanId, marketId ?? undefined).catch(err => setError(errorText(err)))}><RefreshCw size={16} /></button></div><section className="chart-section"><div className="chart-title"><div><span className="market-symbol">{market?.symbol ?? 'MARKET'}</span><span className="venue-badge">{market ? venueName(market.venue) : 'LIVE'}</span></div><span className="chart-updated">{lastRefresh ? `UPDATED ${lastRefresh.toLocaleTimeString()}` : 'CONNECTING'}</span></div><SharedChart candles={snapshot?.candles ?? []} markers={visibleMarkers} market={market ?? { venue: 'perpl', id: '', symbol: '', baseSymbol: '', quoteSymbol: '' }} selectedId={selectedId} onSelect={item => { setSelectedId(item.id); setShareUrl(null); setPanel('positions'); }} /><div className="chart-legend"><span><i className="legend-triangle" /> Clan position</span><span><i className="legend-circle" /> Auto mirrored</span><span><i className="legend-square" /> Manual stack</span><span className="chart-legend-right">{visibleMarkers.length} LIVE MARKERS</span></div></section><div className="positions-strip"><div className="strip-heading"><h2>On this chart</h2><span>{visibleMarkers.length} positions</span></div><div className="position-list">{visibleMarkers.length ? visibleMarkers.map(item => <button key={item.id} className={`position-row ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setPanel('positions'); }}><i className={`origin-icon ${item.origin}`} /><span className="position-person">{item.memberName}{item.isMine && <small>YOU</small>}</span><span className="position-meta">{originName(item.origin)} · {item.side.toUpperCase()}</span><strong className={item.pnlUsd >= 0 ? 'positive' : 'negative'}>{item.venue === 'perpl' ? signedUsd(item.pnlUsd) : usd(item.valueUsd)}</strong></button>) : <p className="empty-line">No open clan positions on this market yet.</p>}</div></div></main>}
    <aside className="detail"><div className="detail-tabs"><button className={panel === 'positions' ? 'active' : ''} onClick={() => setPanel('positions')}>Trade</button><button className={panel === 'members' ? 'active' : ''} onClick={() => setPanel('members')}>Members</button><button className={panel === 'wallet' ? 'active' : ''} onClick={() => setPanel('wallet')}>Wallet</button></div>{panel === 'positions' ? <div className="detail-body">{selected ? <><div className="detail-heading"><span className={`origin-tag ${selected.origin}`}>{originName(selected.origin)}</span><button className="icon-button compact" title="Close position details" onClick={() => setSelectedId(null)}><X size={15} /></button></div><h2>{selected.memberName} {selected.side === 'buy' ? 'holds' : selected.side}</h2><p className="detail-sub">{market?.symbol} on {venueName(selected.venue)}</p><div className="stat-pair"><span>ENTRY</span><strong>{usd(selected.entryPrice, selected.entryPrice < 1 ? 6 : 2)}</strong></div><div className="stat-pair"><span>CURRENT</span><strong>{usd(selected.markPrice, selected.markPrice < 1 ? 6 : 2)}</strong></div>{selected.venue === 'perpl' && <><div className="stat-pair"><span>TAKE PROFIT</span><strong>{selected.takeProfitPrice == null ? '—' : usd(selected.takeProfitPrice)}</strong></div><div className="stat-pair"><span>STOP LOSS</span><strong>{selected.stopLossPrice == null ? '—' : usd(selected.stopLossPrice)}</strong></div></>}<div className="pnl-block"><span>{selected.venue === 'perpl' ? 'LIVE PNL' : 'CURRENT VALUE'}</span><strong className={selected.pnlUsd >= 0 ? 'positive' : 'negative'}>{selected.venue === 'perpl' ? signedUsd(selected.pnlUsd) : usd(selected.valueUsd)}</strong></div>{!selected.isMine ? <><div className="trade-divider" /><h3>Stack this trade</h3><p className="field-note">A new position in your account. This is your choice, separate from automatic mirroring.</p><label className="field-label" htmlFor="stack-size">YOUR SIZE / USD</label><input id="stack-size" type="number" min="1" value={stackUsd} onChange={event => setStackUsd(event.target.value)} /><button className="primary full" disabled={!!busy} onClick={stack}>{selected.venue === 'perpl' ? 'Open my position' : 'Buy with my wallet'} <ArrowRight size={16} /></button></> : <>{selected.origin === 'auto_mirror' && selected.mirrorStatus === 'pending' && selected.skipUntil && Date.parse(selected.skipUntil) > now && <><div className="trade-divider" /><h3>Pending auto mirror</h3><p className="field-note">You can skip this trade for {Math.max(0, Math.ceil((Date.parse(selected.skipUntil) - now) / 1000))} more seconds.</p><button className="outline full" disabled={!!busy} onClick={skip}>Skip this mirror</button></>}<div className="trade-divider" /><h3>Share this result</h3><label className="switch-row"><span>Show clan name</span><input type="checkbox" checked={shareWithClan} onChange={event => setShareWithClan(event.target.checked)} /></label><button className="outline full" disabled={!!busy} onClick={share}><ExternalLink size={15} /> Create public card</button>{shareUrl && <a className="share-link" href={shareUrl} target="_blank" rel="noreferrer">Open public result <ExternalLink size={14} /></a>}</>}</> : <div className="detail-empty"><div className="empty-symbol">↗</div><h2>Select a position</h2><p>Tap a marker on the chart to inspect a clan trade or stack your own.</p></div>}</div> : panel === 'members' ? <div className="detail-body"><div className="detail-section-label">VERIFIED TRACK RECORD</div><h2>Clan members</h2><div className="member-list">{snapshot?.members.map(member => <div className="member-row" key={member.id}><div className="member-top"><span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}</strong><small>{shortAddress(member.address)}</small></div>{member.verified && <ShieldCheck size={15} className="verified" />}</div><div className="member-stats"><span>WIN RATE <strong>{percent(member.winRate)}</strong></span><span>REALIZED PNL <strong className={(member.realizedPnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{member.realizedPnlUsd == null ? '—' : signedUsd(member.realizedPnlUsd)}</strong></span></div><div className="member-trades">{member.tradeCount} verified trades · Perpl + Nad.fun</div></div>)}{!snapshot?.members.length && <p className="field-note">Member records will appear after the indexer syncs.</p>}</div></div> : <div className="detail-body"><div className="detail-section-label">YOUR OWN ACCOUNT</div><h2>Trading wallet</h2><p className="detail-sub">{shortAddress(wallet.address)} · Monad</p><div className="pnl-block"><span>USDC BALANCE</span><strong>{me?.usdcBalance == null ? '—' : usd(Number(me.usdcBalance))}</strong></div><div className="trade-divider" /><h3>Fund your account</h3><p className="field-note">Add USDC with a card or wallet. You approve the funding transactions with your own wallet.</p><label className="field-label" htmlFor="fund-size">AMOUNT / USDC</label><input id="fund-size" type="number" min="1" value={fundUsd} onChange={event => setFundUsd(event.target.value)} /><button className="primary full" disabled={!!busy || !clanId} onClick={fund}><ArrowDownToLine size={16} /> Fund account</button><div className="trade-divider" /><h3>Trading authorization</h3><p className="field-note">Sign once for each venue. These signatures enroll your wallet’s trading keys.</p><button className="outline full" disabled={!!busy} onClick={() => enroll('perpl')}><ShieldCheck size={15} /> Enroll Perpl key</button><button className="outline full" disabled={!!busy} onClick={() => enroll('nadfun')}><ShieldCheck size={15} /> Enroll Nad.fun key</button>{clan && <><div className="trade-divider" /><h3>Invite link</h3><button className="outline full" onClick={copyInvite}><Copy size={15} /> Copy private invite</button></>}</div>}</aside></div>
    {(error || notice) && <div className={`toast ${error ? 'error' : ''}`} role="status">{error ?? notice}<button className="icon-button compact" title="Dismiss" onClick={() => { setError(null); setNotice(null); }}><X size={14} /></button></div>}
    {busy && <div className="busy-bar"><span>{busy === 'stack' ? 'Authorizing your trade' : busy === 'fund' ? 'Preparing wallet funding' : busy === 'join' ? 'Signing clan authorization' : 'Working'}…</span></div>}
  </div>;
}


