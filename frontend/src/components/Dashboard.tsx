'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { getAccessToken, useCreateWallet, usePrivy, useSendTransaction, useSignMessage, useSigners, useWallets } from '@privy-io/react-auth';
import { createPublicClient, formatEther, http, isAddress, isHex } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import { ArrowRight, Compass, ExternalLink, Home, Link2, Plus, RefreshCw, Search, ShieldCheck, UserRound, Wallet, X } from 'lucide-react';
import { createClan, createShare, enrollPerpl, getChart, getPolicyChallenge, updateClanPolicy, leaveClan, getClanEventUrl, getConfig, getEnrollmentChallenge, getHoldings, getNadMarkets, getMe, getPerplSetup, getPrivySigner, setUsername, joinClan, setAutoFollowOff, setCultVisibility, openPosition, closePosition, skipAutoMirror, stackPosition, setPositionTpsl, suggestMarkerTpsl } from '@/lib/api';
import type { BackendConfig, ChatMessage, ChartMarker, ChartSnapshot, Holding, Me, MirrorPolicy, NadMarket, SetupStatus, TpslSuggestion, TpslValues, Venue, WalletAction } from '@/lib/contracts';
import { dollars, percent, shortAddress, signedDollars, signedMon } from '@/lib/format';
import { SharedChart } from './SharedChart';
import { ClanChat } from './ClanChat';
import { DiscoverCults } from './DiscoverCults';
import { UsernameGate } from './UsernameGate';
import { Leaderboards } from './Leaderboards';
import { HomeView } from './HomeView';
import { AccountView } from './AccountView';
import { TradeSheet, type TradeSheetTarget } from './TradeSheet';
import { GroupPanel } from './GroupPanel';
import { DepositSheet } from './DepositSheet';

const venueName = (venue: Venue) => venue === 'perpl' ? 'Perpl' : 'Nad.fun';
const originName = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? 'Auto mirrored' : origin === 'manual_stack' ? 'Manual stack' : 'Cult position';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
const validatePolicy = (value: MirrorPolicy) => {
  if (!Number.isFinite(value.balancePercentCap) || value.balancePercentCap <= 0 || value.balancePercentCap > 100 || !Number.isFinite(value.maxUsdPerTrade) || value.maxUsdPerTrade < 1 || value.maxUsdPerTrade > 1_000_000) throw new Error('Enter mirror limits within the allowed range.');
};
const inviteFromInput = (input: string) => {
  try { return new URL(input).searchParams.get('invite') ?? input.trim(); }
  catch { return input.trim(); }
};
const formatInviteCode = (input: string) => {
  const letters = inviteFromInput(input).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  return letters.length > 3 ? `${letters.slice(0, 3)}-${letters.slice(3)}` : letters;
};

export function Dashboard() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const walletCreateAttempted = useRef(false);
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { sendTransaction } = useSendTransaction();
  const { addSigners } = useSigners();
  const [pendingLogin, setPendingLogin] = useState<'google' | 'wallet' | null>(null);
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [perpsPrompt, setPerpsPrompt] = useState(false);
  const [monBalance, setMonBalance] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [nadMarkets, setNadMarkets] = useState<NadMarket[]>([]);
  const [tradeSide, setTradeSide] = useState<'long' | 'short'>('long');
  const [tradeAusd, setTradeAusd] = useState('50');
  const [tradeLeverage, setTradeLeverage] = useState('2');
  const [depositOpen, setDepositOpen] = useState(false);
  const [createVisibility, setCreateVisibility] = useState<'private' | 'public'>('private');
  const [view, setView] = useState<'home' | 'cult' | 'discover' | 'chat' | 'account' | 'leaderboards'>('home');
  const [profileId, setProfileId] = useState('me');
  const [tradeSheetTarget, setTradeSheetTarget] = useState<TradeSheetTarget | null>(null);
  const [formOpen, setFormOpen] = useState<'create' | 'join' | null>(null);
  const [search, setSearch] = useState('');
  const [roomId, setRoomId] = useState('global');
  const wallet = wallets.find(item => item.walletClientType === 'privy');
  useEffect(() => {
    if (!ready || !authenticated || !walletsReady || wallet || walletCreateAttempted.current) return;
    walletCreateAttempted.current = true;
    void createWallet().catch(reason => setError(errorText(reason)));
  }, [ready, authenticated, walletsReady, wallet, createWallet]);
  const [me, setMe] = useState<Me | null>(null);
  const [clanId, setClanId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChartSnapshot | null>(null);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tpDraft, setTpDraft] = useState('');
  const [slDraft, setSlDraft] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [editPolicy, setEditPolicy] = useState<MirrorPolicy | null>(null);
  const [policyDraftClanId, setPolicyDraftClanId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [mirrorRetries, setMirrorRetries] = useState<Record<string, string>>({});
  const [liveMessage, setLiveMessage] = useState<ChatMessage | null>(null);
  const [stackUsd, setStackUsd] = useState('50');
  const [shareWithClan, setShareWithClan] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [panel, setPanel] = useState<'positions' | 'members' | 'chat' | 'clan'>('positions');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const clan = me?.clans.find(item => item.id === clanId) ?? snapshot?.clan;
  const activeRoom = me?.rooms.find(item => item.id === roomId);
  const selected = snapshot?.markers.find(item => item.id === selectedId) ?? null;
  const market = snapshot?.selectedMarket;
  const balanceMon = me?.balances?.mon ?? monBalance;
  const gasReserveMon = me?.balances?.gasReserveMon ?? 0.25;
  const lowGas = me?.balances?.lowGas ?? (balanceMon != null && balanceMon < gasReserveMon);
  const signerReady = me?.signer.attached === true && me.signer.policyCurrent === true;
  const signerPrompt = !clanId || signerReady ? null : me?.signer.attached === false ? 'Allow Cult to copy trades for you' : me?.signer.policyCurrent === false ? 'Re-approve your new limits' : 'Signer status unavailable. Retry shortly.';
  useEffect(() => {
    if (!ready || !pendingLogin || authenticated) return;
    const method = pendingLogin;
    setPendingLogin(null);
    login({ loginMethods: [method] });
  }, [ready, pendingLogin, authenticated, login]);
  const requestLogin = (method: 'google' | 'wallet') => {
    if (ready) login({ loginMethods: [method] });
    else setPendingLogin(method);
  };
  useEffect(() => {
    if (!clanId || policyDraftClanId === clanId) return;
    const current = me?.clans.find(item => item.id === clanId);
    if (!current) return;
    setEditPolicy(current.myPolicy);
    setPolicyDraftClanId(clanId);
    setConfirmLeave(false);
    setMirrorRetries({});
    setLiveMessage(null);
  }, [clanId, me, policyDraftClanId]);
  const visibleMarkers = useMemo(() => snapshot?.markers.filter(item => item.marketId === market?.id && item.venue === market?.venue) ?? [], [snapshot, market]);

  const token = async () => {
    const value = await getAccessToken();
    if (!value) throw new Error('Sign in again to continue.');
    return value;
  };
  const loadMe = useCallback(async () => {
    const result = await getMe(await token());
    setMe(result);
    if (wallet?.address && result.address.toLowerCase() === wallet.address.toLowerCase()) {
      try { window.localStorage.setItem(`cult:me:${wallet.address.toLowerCase()}`, JSON.stringify(result)); } catch { /* Storage can be unavailable. */ }
    }
    setClanId(current => current ?? result.clans[0]?.id ?? null);
    return result;
  }, [wallet?.address]);
  useEffect(() => {
    if (!authenticated || !wallet?.address) return;
    try {
      const cached = window.localStorage.getItem(`cult:me:${wallet.address.toLowerCase()}`);
      if (!cached) return;
      const value = JSON.parse(cached) as Me;
      if (value.address?.toLowerCase() === wallet.address.toLowerCase()) setMe(value);
    } catch { /* Fresh account data will replace the cache. */ }
  }, [authenticated, wallet?.address]);
  const loadChart = useCallback(async (id: string, market?: string) => {
    const result = await getChart(await token(), id, market);
    setSnapshot(result);
    setMarketId(result.selectedMarket.id);
    setLastRefresh(new Date());
  }, []);
  useEffect(() => {
    if (!authenticated || !ready) return;
    let active = true;
    Promise.all([loadMe(), getConfig().then(setConfig)]).catch(err => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [authenticated, ready, loadMe]);
  useEffect(() => {
    if (!authenticated || !clanId) return;
    let active = true;
    const refresh = () => loadChart(clanId, marketId ?? undefined).catch(err => { if (active) setError(errorText(err)); });
    refresh();
    const interval = window.setInterval(refresh, 30000);
    return () => { active = false; window.clearInterval(interval); };
  }, [authenticated, clanId, marketId, loadChart]);
  useEffect(() => {
    if (!authenticated || !clanId) return;
    let eventUrl: string;
    try { eventUrl = getClanEventUrl(clanId); } catch { return; }
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    class AuthError extends Error {}
    class RateLimitError extends Error {}
    const refresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void Promise.all([loadChart(clanId, marketId ?? undefined), loadMe()]).catch(err => setError(errorText(err)));
      }, 120);
    };
    void fetchEventSource(eventUrl, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
      fetch: async (input, init) => {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new AuthError('Sign in again to receive live updates.');
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${accessToken}`);
        return fetch(input, { ...init, headers });
      },
      onopen: async response => {
        if (response.status === 401 || response.status === 403) throw new AuthError('Live update authorization expired.');
        if (response.status === 429) {
          const seconds = Number(response.headers.get('Retry-After'));
          throw new RateLimitError(Number.isFinite(seconds) && seconds > 0 ? 'Slow down, try again in ' + Math.ceil(seconds) + 's.' : 'Slow down, try again shortly.');
        }
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Live chart stream unavailable.');
        setLiveConnected(true);
      },
      onmessage: message => {
        if (message.event === 'mirror') {
          try {
            const update = JSON.parse(message.data) as { id?: unknown; status?: unknown; error?: unknown };
            if (typeof update.id === 'string') {
              const id = `mirror:${update.id}`;
              setMirrorRetries(current => {
                const next = { ...current };
                if (update.status === 'pending' && typeof update.error === 'string' && update.error.startsWith('retrying (')) next[id] = update.error;
                else delete next[id];
                return next;
              });
            }
          } catch { /* A malformed event cannot replace the chart snapshot. */ }
        }
        if (message.event === 'message') {
          try {
            const incoming = JSON.parse(message.data) as ChatMessage;
            if (incoming.clanId === clanId && typeof incoming.id === 'string' && typeof incoming.body === 'string') setLiveMessage(incoming);
          } catch { /* Ignore a malformed chat event. */ }
        }
        if (['trade', 'trade_changed', 'trade_closed', 'mirror', 'adjustment', 'suggestion'].includes(message.event)) refresh();
      },
      onclose: () => { setLiveConnected(false); throw new Error('Live chart stream closed.'); },
      onerror: error => {
        setLiveConnected(false);
        if (error instanceof AuthError || error instanceof RateLimitError) throw error;
        return 3000;
      },
    }).catch(error => { if (!controller.signal.aborted) { setLiveConnected(false); if (error instanceof RateLimitError) setError(error.message); } });
    return () => { controller.abort(); window.clearTimeout(refreshTimer); setLiveConnected(false); };
  }, [authenticated, clanId, marketId, loadChart, loadMe]);
  useEffect(() => {
    if (!wallet || config?.chainId !== monadTestnet.id) return;
    let active = true;
    const client = createPublicClient({ chain: monadTestnet, transport: http() });
    const refresh = () => client.getBalance({ address: wallet.address as `0x${string}` })
      .then(value => { if (active) setMonBalance(Number(formatEther(value))); })
      .catch(() => { if (active) setMonBalance(null); });
    refresh();
    const timer = window.setInterval(refresh, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [wallet, config?.chainId]);  useEffect(() => {
    if (!authenticated || !wallet) return;
    let active = true;
    const refresh = () => token().then(getHoldings).then(value => { if (active) setHoldings(value.positions); }).catch(err => { if (active) setError(errorText(err)); });
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [authenticated, wallet]);  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    token().then(getNadMarkets).then(value => { if (active) setNadMarkets(value.markets); }).catch(() => {});
    return () => { active = false; };
  }, [authenticated]);  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('invite');
    if (code) { setInviteCode(formatInviteCode(code)); setFormOpen('join'); }
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
    if (!config || action.chainId !== config.chainId) throw new Error('Wallet action chain does not match backend configuration.');
    if (!isAddress(action.to) || !isHex(action.data)) throw new Error('Backend returned an invalid wallet action.');
    await wallet.switchChain(action.chainId);
    const result = await sendTransaction({ to: action.to, data: action.data, value: BigInt(action.value ?? '0x0') }, { address: wallet.address });
    const chain = config.chainId === monad.id ? monad : monadTestnet;
    const receipt = await createPublicClient({ chain, transport: http() }).waitForTransactionReceipt({ hash: result.hash });
    if (receipt.status !== 'success') throw new Error(`${action.label} failed on-chain.`);
    return result.hash;
  };
  const grantSigner = async () => {
    if (!wallet) throw new Error('Create your Privy wallet first.');
    const value = await getPrivySigner(await token());
    await addSigners({ address: wallet.address, signers: [{ signerId: value.signerId, policyIds: value.policyIds }] });
    const current = await loadMe();
    return current.signer.attached === true && current.signer.policyCurrent === true;
  };  const enterCult = async (joined: Me['clans'][number]) => {
    await loadMe();
    setClanId(joined.id);
    setRoomId(`cult:${joined.id}`);
    setView('chat');
    setSnapshot(null);
    setSelectedId(null);
    window.history.replaceState({}, '', '/');
  };
  const create = () => perform('create', async () => {
    if (!name.trim()) throw new Error('Name your cult first.');
    const created = await createClan(await token(), name.trim(), createVisibility);
    await enterCult(created);
    setFormOpen(null);
    setNotice(`Cult created. Invite code: ${created.inviteCode}`);
  });
  const joinTarget = async (target: { inviteCode: string } | { cultId: string }) => {
    const joined = await joinClan(await token(), target);
    await enterCult(joined);
    setFormOpen(null);
    setNotice(`Joined ${joined.name}. Auto-follow is off until you turn it on.`);
  };
  const join = () => perform('join', async () => {
    const code = formatInviteCode(inviteCode);
    if (!/^[A-Z]{3}-[A-Z]{3}$/.test(code)) throw new Error('Enter a six-letter invite code.');
    await joinTarget({ inviteCode: code });
  });
  const joinPublic = (cultId: string) => perform('join', () => joinTarget({ cultId }));
  const changeVisibility = (visibility: 'private' | 'public') => perform('visibility', async () => {
    if (!clanId || !clan?.isOwner) throw new Error('Only the Cult owner can change visibility.');
    await setCultVisibility(await token(), clanId, visibility);
    await loadMe();
    await loadChart(clanId, marketId ?? undefined);
    setNotice(visibility === 'public' ? 'Your Cult is now discoverable.' : 'Your Cult now requires an invite.');
  });
  const savePolicy = () => perform('policy', async () => {
    if (!clanId || !clan?.myPolicy || !editPolicy) throw new Error('Select a cult policy first.');
    validatePolicy(editPolicy);
    const oldCap = clan.myPolicy.maxUsdPerTrade;
    const auth = await token();
    const challenge = await getPolicyChallenge(auth, clanId, editPolicy);
    const signature = await sign(challenge.message);
    const updated = await updateClanPolicy(auth, clanId, challenge.challengeId, signature);
    setEditPolicy(updated.myPolicy);
    await loadMe();
    if (editPolicy.maxUsdPerTrade !== oldCap) {
      try {
        const confirmed = await grantSigner();
        setNotice(confirmed ? 'Your signed policy and signer limits are active.' : 'Policy saved. Signer limits are awaiting Privy verification.');
      } catch {
        throw new Error('Policy saved, but the new limits still need wallet signer approval. Retry in Wallet.');
      }
    } else setNotice('Your signed mirror policy is updated.');
  });
  const leave = () => perform('leave', async () => {
    if (!clanId) throw new Error('Choose a cult first.');
    await leaveClan(await token(), clanId);
    const remaining = await loadMe();
    setClanId(remaining.clans[0]?.id ?? null);
    setPolicyDraftClanId(null);
    setEditPolicy(null);
    setSnapshot(null);
    setSelectedId(null);
    setConfirmLeave(false);
    setPanel('positions');
    setView('home');
    setNotice('You left the cult. Open mirrors will still unwind when their leader exits.');
  });
  const enableAutoFollow = async (policy: MirrorPolicy) => {
    if (!clanId) throw new Error('Choose a cult first.');
    validatePolicy(policy);
    setBusy('auto-follow'); setError(null);
    try {
      const auth = await token();
      const challenge = await getPolicyChallenge(auth, clanId, policy);
      const signature = await sign(challenge.message);
      await updateClanPolicy(auth, clanId, challenge.challengeId, signature);
      const current = await loadMe();
      if (current.signer.attached !== true || current.signer.policyCurrent !== true) {
        const confirmed = await grantSigner();
        setNotice(confirmed ? 'Auto-follow is on and your wallet signer is ready.' : 'Auto-follow is on. Signer approval is awaiting Privy verification.');
      } else setNotice('Auto-follow is on. Your limits are signed.');
    } catch (reason) { setError(errorText(reason)); throw reason; }
    finally { setBusy(null); }
  };
  const disableAutoFollow = async () => {
    if (!clanId) return;
    setBusy('auto-follow'); setError(null);
    try { await setAutoFollowOff(await token(), clanId); await loadMe(); setNotice('Auto-follow is off.'); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(null); }
  };
  const enroll = () => perform('enroll-perpl', async () => {
    if (!wallet || !config) throw new Error('Connect your trading wallet first.');
    const auth = await token();
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await getPerplSetup(auth);
      setSetup(current);
      if (current.step === 'ready') { setPerpsPrompt(false); setNotice('Perps are enabled.'); return; }
      if (current.step === 'needs_collateral') throw new Error('Fund your wallet, then continue Perpl setup. Keep MON for gas.');
      if (current.step === 'needs_key') {
        await wallet.switchChain(config.chainId);
        const challenge = await getEnrollmentChallenge(auth);
        if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('Enrollment challenge expired. Try again.');
        const provider = await wallet.getEthereumProvider();
        const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [wallet.address, JSON.stringify(challenge.typedData)] });
        if (typeof signature !== 'string') throw new Error('Wallet did not return a signature.');
        await enrollPerpl(auth, challenge.challengeId, signature);
      } else {
        if (!current.actions.length) throw new Error('No wallet action is available for this setup step yet.');
        for (const action of current.actions) await transact(action);
      }
      const next = await getPerplSetup(auth);
      setSetup(next);
      if (next.step === current.step) { setNotice('Wallet action confirmed. Continue setup after the backend updates.'); return; }
    }
    throw new Error('Setup is still in progress. Continue after refreshing its status.');
  });
  const ensurePerps = async () => {
    const current = await getPerplSetup(await token());
    setSetup(current);
    if (current.step === 'ready') return true;
    setPerpsPrompt(true);
    return false;
  };
  const skip = () => perform('skip', async () => {
    if (!clanId || !selected || selected.origin !== 'auto_mirror' || selected.mirrorStatus !== 'pending' || !selected.skipUntil || Date.parse(selected.skipUntil) <= Date.now()) throw new Error('The skip window has closed.');
    await skipAutoMirror(await token(), clanId, selected.id);
    await loadChart(clanId, marketId ?? undefined);
    setNotice('This automatic mirror was skipped.');
  });
  const skipAdd = () => perform('skip-add', async () => {
    if (!clanId || !selected?.isMine || selected.origin !== 'auto_mirror' || !selected.pendingAdd || Date.parse(selected.pendingAdd.skipUntil) <= Date.now()) throw new Error('The add skip window has closed.');
    await skipAutoMirror(await token(), clanId, selected.pendingAdd.id);
    await loadChart(clanId, marketId ?? undefined);
    setNotice('You skipped this add. Your open copy remains yours.');
  });
  const requireNadFunds = (amountUsd: number) => {
    const balances = me?.balances;
    if (!balances && config?.chainId === 143) throw new Error('Wallet balance data is unavailable. Refresh before buying.');
    if (lowGas) throw new Error('MON is too low for gas. Top up your wallet first.');
    if (balances?.memesPayWith === 'ausd') {
      if (balances.walletUsd < amountUsd) throw new Error('Not enough dollars in your wallet for this buy.');
      return;
    }
    const price = config?.monPriceAusd;
    const mon = balances?.mon ?? monBalance;
    if (mon == null || !price || price <= 0) throw new Error('MON balance or price is unavailable. Wait for it before buying.');
    if (mon < amountUsd / price + gasReserveMon) throw new Error('Not enough MON for this buy plus gas reserve.');
  };
  const openTrade = () => perform('open', async () => {
    if (!market || !clanId) throw new Error('Select a market first.');
    const amount = Number(tradeAusd);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid dollar amount.');
    if (market.venue === 'nadfun') requireNadFunds(amount);
    if (market.venue === 'perpl' && !await ensurePerps()) return;
    const leverage = market.venue === 'perpl' ? Number(tradeLeverage) : undefined;
    if (leverage !== undefined && (!Number.isFinite(leverage) || leverage < 1 || leverage > market.maxLeverage)) throw new Error('Leverage is outside this market\'s limit.');
    await openPosition(await token(), market.id, market.venue === 'nadfun' ? 'buy' : tradeSide, amount, leverage);
    await loadChart(clanId, marketId ?? undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice('Your own trade is open on the cult chart.');
  });
  const closeTrade = (holding: Holding) => perform('close', async () => {
    await closePosition(await token(), holding.market);
    if (clanId) await loadChart(clanId, marketId ?? undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice('Position close submitted.');
  });  const stack = () => perform('stack', async () => {
    if (!clanId || !selected) throw new Error('Select a cult position first.');
    if (selected.isMine) throw new Error('Choose a cult-mate position to stack.');
    const amount = Number(stackUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.');
    if (selected.venue === 'nadfun') requireNadFunds(amount);
    if (selected.venue === 'perpl' && !await ensurePerps()) return;
    const result = await stackPosition(await token(), clanId, selected.id, amount);
    if (result.status !== 'open') throw new Error(result.error ?? 'The stack could not be opened.');
    await loadChart(clanId, marketId ?? undefined);
    await loadMe();
    setNotice('Manual stack opened in your own account.');
  });  const share = () => perform('share', async () => {
    if (!selected?.isMine) throw new Error('Select one of your own trades.');
    const result = await createShare(await token(), selected.id, shareWithClan);
    setShareUrl(`${window.location.origin}/share/${encodeURIComponent(result.id)}`); setNotice('Public result link created.');
  });
  const selectMarker = (marker: ChartMarker) => {
    setSelectedId(marker.id);
    setTpDraft(marker.takeProfitPrice?.toString() ?? '');
    setSlDraft(marker.stopLossPrice?.toString() ?? '');
    setShareUrl(null);
    setPanel('positions');
  };
  const openLinkedMarker = (id: string) => perform('open-linked', async () => {
    const onThisChart = snapshot?.markers.find(item => item.id === id);
    if (onThisChart) { selectMarker(onThisChart); return; }
    if (!clanId || !snapshot) throw new Error('Open a cult chart to view this trade.');
    const auth = await token();
    for (const candidate of snapshot.markets) {
      if (candidate.id === snapshot.selectedMarket.id) continue;
      const result = await getChart(auth, clanId, candidate.id);
      const linked = result.markers.find(item => item.id === id);
      if (!linked) continue;
      setSnapshot(result);
      setMarketId(result.selectedMarket.id);
      setLastRefresh(new Date());
      selectMarker(linked);
      return;
    }
    throw new Error('This linked trade is no longer open on the cult chart.');
  });
  const validateLevel = (marker: ChartMarker, kind: 'takeProfit' | 'stopLoss', price: number) => {
    if (!Number.isFinite(price) || price <= 0) throw new Error('Enter a positive dollar price.');
    const shouldBeAbove = (kind === 'takeProfit') === (marker.side === 'long');
    if (price === marker.markPrice || (price > marker.markPrice) !== shouldBeAbove) {
      throw new Error(`${kind === 'takeProfit' ? 'Take profit' : 'Stop loss'} must be ${shouldBeAbove ? 'above' : 'below'} the current mark.`);
    }
  };
  const submitGuide = (marker: ChartMarker, kind: 'takeProfit' | 'stopLoss', price: number) => perform('tpsl', async () => {
    if (!clanId || marker.venue !== 'perpl' || marker.entryPrice == null) throw new Error('Select an open Perpl position.');
    validateLevel(marker, kind, price);
    const values: TpslValues = kind === 'takeProfit' ? { takeProfit: price } : { stopLoss: price };
    const auth = await token();
    if (marker.isMine) await setPositionTpsl(auth, marker.marketId, values);
    else await suggestMarkerTpsl(auth, clanId, marker.id, values);
    if (selectedId === marker.id) {
      if (kind === 'takeProfit') setTpDraft(String(price)); else setSlDraft(String(price));
    }
    await loadChart(clanId, marketId ?? undefined);
    setNotice(marker.isMine ? 'Trigger order updated.' : 'Price suggestion sent to the position owner.');
  });
  const saveLevels = () => perform('tpsl', async () => {
    if (!clanId || !selected || selected.venue !== 'perpl' || selected.entryPrice == null) throw new Error('Select an open Perpl position.');
    const takeProfit = tpDraft.trim() === '' ? null : Number(tpDraft);
    const stopLoss = slDraft.trim() === '' ? null : Number(slDraft);
    if (takeProfit != null) validateLevel(selected, 'takeProfit', takeProfit);
    if (stopLoss != null) validateLevel(selected, 'stopLoss', stopLoss);
    if (!selected.isMine && takeProfit == null && stopLoss == null && selected.takeProfitPrice == null && selected.stopLossPrice == null) throw new Error('Enter at least one price to suggest.');
    const values = { takeProfit, stopLoss };
    const auth = await token();
    if (selected.isMine) await setPositionTpsl(auth, selected.marketId, values);
    else await suggestMarkerTpsl(auth, clanId, selected.id, values);
    await loadChart(clanId, marketId ?? undefined);
    setNotice(selected.isMine ? 'Trigger orders updated.' : 'Price suggestion sent to the position owner.');
  });
  const applySuggestion = (suggestion: TpslSuggestion) => perform('apply-tpsl', async () => {
    if (!selected?.isMine || selected.venue !== 'perpl' || !clanId) throw new Error('Only the position owner can apply a suggestion.');
    if (suggestion.takeProfitPrice != null) validateLevel(selected, 'takeProfit', suggestion.takeProfitPrice);
    if (suggestion.stopLossPrice != null) validateLevel(selected, 'stopLoss', suggestion.stopLossPrice);
    await setPositionTpsl(await token(), selected.marketId, { takeProfit: suggestion.takeProfitPrice, stopLoss: suggestion.stopLossPrice });
    setTpDraft(suggestion.takeProfitPrice?.toString() ?? '');
    setSlDraft(suggestion.stopLossPrice?.toString() ?? '');
    await loadChart(clanId, marketId ?? undefined);
    setNotice('Suggestion applied to your trigger orders.');
  });
  const openRoom = (id: string) => {
    setRoomId(id);
    setView('chat');
    if (id.startsWith('cult:')) { setClanId(id.slice(5)); setSnapshot(null); setSelectedId(null); }
  };
  const openAccount = (id = 'me') => { setProfileId(id); setView('account'); };
  const openTradeChart = (cultId: string, markerId: string, tradeMarket: string) => perform('open-chart', async () => {
    const result = await getChart(await token(), cultId, tradeMarket);
    const marker = result.markers.find(item => item.id === markerId);
    if (!marker) throw new Error('This trade is no longer open on the Cult chart.');
    setClanId(cultId);
    setRoomId(`cult:${cultId}`);
    setSnapshot(result);
    setMarketId(result.selectedMarket.id);
    selectMarker(marker);
    setTradeSheetTarget(null);
    setView(me?.clans.some(item => item.id === cultId) ? 'chat' : 'cult');
  });
  const copyInvite = async () => {
    if (!clan) return;
    await navigator.clipboard.writeText(`${window.location.origin}/?invite=${encodeURIComponent(clan.inviteCode)}`);
    setNotice('Invite link copied.');
  };

  if (!ready || !authenticated) return <main className="login-screen"><div className="login-brand">CULT<span>.</span></div><div className="login-main"><p className="eyebrow">CULTS / MONAD</p><h1>Trade together.<br />Own every move.</h1><p>One chart for your cult’s live positions across Perpl and Nad.fun. Your wallet, your funds, your trades.</p><div className="login-actions"><button className="primary large" onClick={() => requestLogin('google')}>Continue with Google {pendingLogin === 'google' && <span className="button-spinner" aria-hidden="true" />}</button><button className="outline large" onClick={() => requestLogin('wallet')}>Connect wallet {pendingLogin === 'wallet' && <span className="button-spinner" aria-hidden="true" />}</button></div></div><div className="login-foot">PUBLIC + PRIVATE CULTS <span>•</span> NO SHARED CUSTODY</div></main>;
  if (me?.needsUsername) return <UsernameGate onSave={async username => { await setUsername(await token(), username); await loadMe(); }} />;

  return <div className="app-shell">
    <div className="workspace">
      <aside className="rail side-rail">
        <div className="rail-logo">CULT<span>.</span></div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}><Home size={17} /> Home</button>
          <button className={view === 'discover' || view === 'leaderboards' ? 'active' : ''} onClick={() => setView('discover')}><Compass size={17} /> Discover</button>
          <button className={view === 'account' ? 'active' : ''} onClick={() => openAccount()}><UserRound size={17} /> Account</button>
        </nav>
        <div className="rail-heading">YOUR GROUPS <button className="icon-button compact" title="Create a cult" onClick={() => setFormOpen('create')}><Plus size={15} /></button></div>
        <div className="room-nav">{me?.rooms.filter(room => room.name.toLowerCase().includes(search.trim().toLowerCase())).map(room => <button key={room.id} className={view === 'chat' && roomId === room.id ? 'active' : ''} onClick={() => openRoom(room.id)}>
          <span className={`room-avatar ${room.kind}`}>{room.icon}</span>
          <span className="room-lines"><strong>{room.name}</strong><small>{room.lastMessage?.text ?? 'No messages yet'}</small></span>
          <time>{room.lastMessage ? new Date(room.lastMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time>
        </button>)}</div>
        <div className="rail-quick"><button onClick={() => setFormOpen('create')}><Plus size={15} /> Create a cult</button><button onClick={() => setFormOpen('join')}><Link2 size={15} /> Got an invite code?</button></div>
        <div className="rail-footer"><span className="tiny-label">SIGNED IN AS</span><strong>{me?.name ?? 'Account'}</strong><span>{wallet?.address ? shortAddress(wallet.address) : 'Wallet connecting'}</span></div>
      </aside>
      <div className="content-topbar"><label className="top-search"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search groups or markets" aria-label="Search groups or markets" /></label><div className="topbar-right"><span className="balance-pill">{me?.balances ? dollars(me.balances.walletUsd + (me.balances.perplMarginUsd ?? 0)) : '—'}</span><button className="primary" onClick={() => setDepositOpen(true)}><Wallet size={15} /> Deposit</button></div></div>
    {!me ? <main className="home-layout shell-loading"><div className="home-main"><div className="skeleton-line wide" /><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line short" /></div><aside className="home-right"><div className="skeleton-card" /><div className="skeleton-card" /></aside></main>
      : view === 'home' ? <HomeView me={me} config={config} holdings={holdings} nadMarkets={nadMarkets} search={search} onRoom={openRoom} onProfile={openAccount} onTrade={trade => setTradeSheetTarget(trade.tradeId ? { kind: 'trade', tradeId: trade.tradeId } : { kind: 'home', trade })} onDeposit={() => setDepositOpen(true)} />
      : view === 'discover' ? <DiscoverCults busy={!!busy} onJoin={joinPublic} country={me?.country ?? null} cultId={clanId} onProfile={openAccount} search={search} />
      : view === 'leaderboards' ? <Leaderboards country={me?.country ?? null} cultId={clanId} />
      : view === 'account' ? <AccountView id={profileId} holdings={holdings} onCloseHolding={closeTrade} onCountrySaved={loadMe} onDeposit={() => setDepositOpen(true)} onSignOut={logout} onTrade={setTradeSheetTarget} />
      : view === 'chat' ? <main className="full-workspace room-screen">{activeRoom ? <ClanChat key={activeRoom.id} room={activeRoom} liveMessage={activeRoom.kind === 'cult' ? liveMessage : null} selectedMarker={activeRoom.kind === 'cult' ? selected : null} onOpenMarker={openLinkedMarker} onMember={openAccount} onActivity={loadMe} onInvite={activeRoom.kind === 'cult' ? copyInvite : undefined} canPin={!!clan?.isOwner && activeRoom.kind === 'cult'} /> : <p className="field-note">This room is unavailable. Refresh your account or choose a country.</p>}</main>
      : !clanId ? <main className="full-workspace"><p className="field-note">Choose a Cult from your groups.</p></main> : <main className="main"><div className="main-head"><div><div className="eyebrow">CULT / {clan?.memberCount ?? 0} MEMBERS</div><h1>{clan?.name ?? 'Cult'}</h1></div><button className="outline" onClick={copyInvite}><Link2 size={15} /> Invite</button></div><div className="market-head"><div className="market-tabs">{snapshot?.markets.map(item => <button key={`${item.venue}:${item.id}`} className={item.id === market?.id && item.venue === market.venue ? 'active' : ''} onClick={() => { setMarketId(item.id); setSelectedId(null); }}><span>{item.symbol}</span><small>{venueName(item.venue)}</small></button>)}</div><select className="nad-market-picker" aria-label="Nad.fun token" value={market?.venue === 'nadfun' ? market.id : ''} onChange={event => { if (event.target.value) { setMarketId(event.target.value); setSelectedId(null); } }}><option value="">Nad.fun token</option>{nadMarkets.map(item => <option key={item.id} value={item.id}>{item.symbol}</option>)}</select><button className="icon-button" title="Refresh chart" onClick={() => loadChart(clanId, marketId ?? undefined).catch(err => setError(errorText(err)))}><RefreshCw size={16} /></button></div><section className="chart-section"><div className="chart-title"><div><span className="market-symbol">{market?.symbol ?? 'MARKET'}</span><span className="venue-badge">{market ? venueName(market.venue) : 'LIVE'}</span></div><span className="chart-updated">{lastRefresh ? `${liveConnected ? 'LIVE' : 'UPDATED'} ${lastRefresh.toLocaleTimeString()}` : 'CONNECTING'}</span></div><SharedChart candles={snapshot?.candles ?? []} markers={visibleMarkers} market={market ?? { venue: 'perpl', id: '', symbol: '', baseSymbol: '', quoteSymbol: 'USD', maxLeverage: 1, makerFeeBps: null, takerFeeBps: null }} selectedId={selectedId} onSelect={selectMarker} onGuideDrop={(marker, kind, price) => { void submitGuide(marker, kind, price); }} guidesDisabled={!!busy} /><div className="chart-legend"><span><i className="legend-triangle" /> Cult position</span><span><i className="legend-circle" /> Auto mirrored</span><span><i className="legend-square" /> Manual stack</span><span className="chart-legend-right">{visibleMarkers.length} LIVE MARKERS</span></div></section><div className="positions-strip"><div className="strip-heading"><h2>On this chart</h2><span>{visibleMarkers.length} positions</span></div><div className="position-list">{visibleMarkers.length ? visibleMarkers.map(item => <button key={item.id} className={`position-row ${item.id === selectedId ? 'selected' : ''}`} onClick={() => selectMarker(item)}><i className={`origin-icon ${item.origin}`} /><span className="position-person">{item.memberName}{item.isMine && <small>YOU</small>}</span><span className="position-meta">{originName(item.origin)} · {item.side.toUpperCase()}{item.mirrorStatus === 'pending' && mirrorRetries[item.id] ? ' · RETRYING' : ''}{item.pendingAdd ? ` · ADD x${item.pendingAdd.ratio.toFixed(2)}` : ''}</span><strong className={(item.pnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{item.venue === 'perpl' ? item.pnlUsd == null ? 'Pending' : signedDollars(item.pnlUsd) : item.valueUsd == null ? 'Pending' : dollars(item.valueUsd)}</strong></button>) : <p className="empty-line">No open cult positions on this market yet.</p>}</div></div></main>}
    {view === 'chat' && activeRoom && <GroupPanel room={activeRoom} cult={activeRoom.kind === 'cult' ? clan ?? null : null} config={config} snapshot={activeRoom.kind === 'cult' ? snapshot : null} selected={activeRoom.kind === 'cult' ? selected : null} busy={!!busy} signerPrompt={signerPrompt} onGrantSigner={() => { void perform('grant-signer', async () => { const confirmed = await grantSigner(); setNotice(confirmed ? 'Trading signer is active.' : 'Signer approval is awaiting Privy verification.'); }); }} onFollowOn={enableAutoFollow} onFollowOff={disableAutoFollow} onMarket={id => { setMarketId(id); setSelectedId(null); }} onMarker={selectMarker} onOpenTrade={() => { setView('cult'); setPanel('positions'); }} onGuideDrop={(marker, kind, price) => { void submitGuide(marker, kind, price); }} onInvite={copyInvite} onVisibility={changeVisibility} onLeave={leave} onProfile={openAccount} />}
    {wallet && view === 'cult' && <aside className="detail"><div className="detail-tabs"><button className={panel === 'positions' ? 'active' : ''} onClick={() => setPanel('positions')}>Trade</button><button className={panel === 'members' ? 'active' : ''} onClick={() => setPanel('members')}>Members</button><button className={panel === 'chat' ? 'active' : ''} onClick={() => setPanel('chat')}>Chat</button><button className={panel === 'clan' ? 'active' : ''} onClick={() => setPanel('clan')}>Cult</button></div>{panel === 'positions' ? <div className="detail-body">{selected ? <><div className="detail-heading"><span className={`origin-tag ${selected.origin}`}>{originName(selected.origin)}</span><button className="icon-button compact" title="Close position details" onClick={() => setSelectedId(null)}><X size={15} /></button></div><h2>{selected.memberName} {selected.side === 'buy' ? 'holds' : selected.side}</h2><p className="detail-sub">{market?.symbol} on {venueName(selected.venue)}</p>{selected.mirrorStatus === 'pending' && mirrorRetries[selected.id] && <p className="wallet-warning">{mirrorRetries[selected.id]}</p>}<div className="stat-pair"><span>ENTRY</span><strong>{selected.entryPrice == null ? 'Pending' : dollars(selected.entryPrice, selected.entryPrice < 1 ? 6 : 2)}</strong></div><div className="stat-pair"><span>CURRENT</span><strong>{dollars(selected.markPrice, selected.markPrice < 1 ? 6 : 2)}</strong></div>{selected.venue === 'perpl' && selected.entryPrice != null && <><div className="stat-pair"><span>TAKE PROFIT</span><strong>{dollars(selected.takeProfitPrice)}</strong></div><div className="stat-pair"><span>STOP LOSS</span><strong>{dollars(selected.stopLossPrice)}</strong></div></>}<div className="pnl-block"><span>{selected.venue === 'perpl' ? 'LIVE PNL' : 'CURRENT VALUE'}</span><strong className={(selected.pnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{selected.venue === 'perpl' ? selected.pnlUsd == null ? 'Pending' : signedDollars(selected.pnlUsd) : selected.valueUsd == null ? 'Pending' : dollars(selected.valueUsd)}</strong></div>{selected.venue === 'perpl' && selected.entryPrice != null && <><div className="trade-divider" /><h3>{selected.isMine ? 'Manage TP / SL' : 'Suggest TP / SL'}</h3><div className="level-fields"><label><span className="field-label">TAKE PROFIT / $</span><input type="number" step="any" value={tpDraft} onChange={event => setTpDraft(event.target.value)} /></label><label><span className="field-label">STOP LOSS / $</span><input type="number" step="any" value={slDraft} onChange={event => setSlDraft(event.target.value)} /></label></div><button className="outline full" disabled={!!busy} onClick={saveLevels}>{selected.isMine ? 'Save trigger orders' : 'Send suggestion'}</button></>}{!selected.isMine ? <><div className="trade-divider" /><h3>Stack this trade</h3><p className="field-note">A new position in your account. This is your choice, separate from automatic mirroring.</p><label className="field-label" htmlFor="stack-size">YOUR SIZE / $</label><input id="stack-size" type="number" min="1" value={stackUsd} onChange={event => setStackUsd(event.target.value)} /><button className="primary full" disabled={!!busy} onClick={stack}>{selected.venue === 'perpl' ? 'Open my position' : 'Buy in my account'} <ArrowRight size={16} /></button></> : <>{selected.origin === 'auto_mirror' && selected.mirrorStatus === 'pending' && selected.skipUntil && Date.parse(selected.skipUntil) > now && <><div className="trade-divider" /><h3>Pending auto mirror</h3><p className="field-note">You can skip this trade for {Math.max(0, Math.ceil((Date.parse(selected.skipUntil) - now) / 1000))} more seconds.</p><button className="outline full" disabled={!!busy} onClick={skip}>Skip this mirror</button></>}{selected.pendingAdd && <><div className="trade-divider" /><h3>Leader is adding (x{selected.pendingAdd.ratio.toFixed(2)})</h3><p className="field-note">Your open copy will add the same share after the skip window. {Date.parse(selected.pendingAdd.skipUntil) > now ? `Skip within ${Math.max(0, Math.ceil((Date.parse(selected.pendingAdd.skipUntil) - now) / 1000))} seconds.` : 'The add is processing.'}</p>{Date.parse(selected.pendingAdd.skipUntil) > now && <button className="outline full" disabled={!!busy} onClick={skipAdd}>Skip this add</button>}</>}{selected.venue === 'perpl' && !!selected.suggestions?.length && <><div className="trade-divider" /><h3>Cult suggestions</h3><div className="suggestion-list">{selected.suggestions.map(suggestion => <div className="suggestion-row" key={suggestion.id}><div><strong>{suggestion.fromName}</strong><span>TP {dollars(suggestion.takeProfitPrice)} · SL {dollars(suggestion.stopLossPrice)}</span><small>{new Date(suggestion.createdAt).toLocaleString()}</small></div><button className="outline" disabled={!!busy} onClick={() => applySuggestion(suggestion)}>Apply</button></div>)}</div></>}<div className="trade-divider" /><h3>Share this result</h3><label className="switch-row"><span>Show cult name</span><input type="checkbox" checked={shareWithClan} onChange={event => setShareWithClan(event.target.checked)} /></label><button className="outline full" disabled={!!busy} onClick={share}><ExternalLink size={15} /> Create public card</button>{shareUrl && <a className="share-link" href={shareUrl} target="_blank" rel="noreferrer">Open public result <ExternalLink size={14} /></a>}</>}</> : <div className="trade-ticket"><div className="detail-section-label">YOUR OWN TRADE</div><h2>{market?.symbol ?? 'Select a market'}</h2><p className="detail-sub">{market ? venueName(market.venue) : 'Your account'}</p>{market?.venue === 'perpl' && <div className="funding-modes"><button className={tradeSide === 'long' ? 'active' : ''} onClick={() => setTradeSide('long')}>Long</button><button className={tradeSide === 'short' ? 'active' : ''} onClick={() => setTradeSide('short')}>Short</button></div>}<label className="field-label" htmlFor="trade-amount">{market?.venue === 'nadfun' ? 'BUY SIZE / $' : 'MARGIN / $'}</label><input id="trade-amount" type="number" min="1" value={tradeAusd} onChange={event => setTradeAusd(event.target.value)} />{market?.venue === 'perpl' && <><label className="field-label" htmlFor="trade-leverage">LEVERAGE</label><input id="trade-leverage" type="number" min="1" max={market.maxLeverage} value={tradeLeverage} onChange={event => setTradeLeverage(event.target.value)} /></>}{market?.venue === 'nadfun' && <p className="field-note">{me?.balances?.memesPayWith === 'ausd' ? 'Paid from wallet dollars. Keep MON for gas.' : 'Paid in MON from your wallet.'} {config?.monPriceAusd ? `1 MON = ${dollars(config.monPriceAusd)}` : 'MON price unavailable.'}</p>}<button className="primary full" disabled={!!busy || !market} onClick={openTrade}>{market?.venue === 'nadfun' ? 'Buy token' : 'Open position'} <ArrowRight size={16} /></button><div className="trade-divider" /><h3>Cult positions</h3><p className="field-note">Select a marker on the chart to inspect or stack it manually.</p></div>}</div> : panel === 'members' ? <div className="detail-body"><div className="detail-section-label">CULT TRACK RECORD</div><h2>Cult members</h2><div className="member-list">
        {snapshot?.members.map(member => <div className="member-row" key={member.id}>
          <div className="member-top"><span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}</strong><small>{shortAddress(member.address)}</small></div>{member.verified ? <ShieldCheck size={15} className="verified" /> : <small className="unverified">UNVERIFIED</small>}</div>
          <div className="member-stats"><span>WIN RATE<strong>{member.verified ? percent(member.winRate == null ? null : member.winRate * 100) : '—'}</strong></span><span>OWN TRADES<strong>{member.verified ? member.tradeCount : '—'}</strong></span><span>REALIZED PNL<strong className={(member.realizedPnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{member.verified && member.realizedPnlUsd != null ? signedDollars(member.realizedPnlUsd) : '—'}</strong></span></div>
          {member.verified ? <><div className="member-venues"><span>Perpl <strong>{signedDollars(member.stats.realizedPnlPerplUsd)}</strong></span><span>Nad.fun <strong>{signedMon(member.stats.realizedPnlMon)}</strong></span></div><div className="member-copied"><span>{member.stats.copied.tradeCount ? `+${member.stats.copied.tradeCount}` : '0'} copied</span>{member.stats.copied.winRate != null && <span>{percent(member.stats.copied.winRate * 100)} win rate</span>}{member.stats.copied.realizedPnlUsd != null && <span>{signedDollars(member.stats.copied.realizedPnlUsd)}</span>}</div></> : <p className="member-trades">Track record awaits indexer verification.</p>}
        </div>)}
        {!snapshot?.members.length && <p className="field-note">Member records will appear after the indexer syncs.</p>}
      </div></div> : panel === 'chat' ? <ClanChat key={clanId ?? ''} room={me?.rooms.find(room => room.id === `cult:${clanId}`) ?? { id: `cult:${clanId}`, kind: 'cult', name: clan?.name ?? 'Cult chat', icon: clan?.name.slice(0, 1).toUpperCase() ?? 'C', memberCount: clan?.memberCount ?? 0, lastMessage: null }} liveMessage={liveMessage} selectedMarker={selected} onOpenMarker={openLinkedMarker} onMember={openAccount} onActivity={loadMe} onInvite={copyInvite} canPin={!!clan?.isOwner} /> : panel === 'clan' ? <div className="detail-body">
      <div className="detail-section-label">CULT</div>
      <h2>Mirror policy</h2>
      <p className="detail-sub">{clan?.name}</p>
      <p className="field-note">Changing these limits requires your wallet signature. Your account and funds remain yours.</p>
      {editPolicy ? <>
        <label className="switch-row"><span>Auto mirror</span><input type="checkbox" checked={editPolicy.enabled} onChange={event => setEditPolicy({ ...editPolicy, enabled: event.target.checked })} /></label>
        <div className="policy-fields"><label><span className="field-label">UP TO % OF BALANCE</span><input type="number" min="1" max="100" value={editPolicy.balancePercentCap} onChange={event => setEditPolicy({ ...editPolicy, balancePercentCap: Number(event.target.value) })} /></label><label><span className="field-label">MAX $ PER TRADE</span><input type="number" min="1" max="1000000" value={editPolicy.maxUsdPerTrade} onChange={event => setEditPolicy({ ...editPolicy, maxUsdPerTrade: Number(event.target.value) })} /></label></div>
        <button className="primary full" disabled={!!busy || JSON.stringify(editPolicy) === JSON.stringify(clan?.myPolicy)} onClick={savePolicy}>Sign policy update</button>
        {clan?.myPolicy && editPolicy.maxUsdPerTrade > clan.myPolicy.maxUsdPerTrade && <p className="field-note">A higher cap also requires a fresh capped signer approval in your wallet.</p>}
      </> : <p className="field-note">Your policy is unavailable. Refresh your cult before changing it.</p>}
      <div className="trade-divider" />
      {clan?.isOwner && <><h3>Visibility</h3><div className="funding-modes"><button className={clan.visibility === 'private' ? 'active' : ''} disabled={!!busy} onClick={() => changeVisibility('private')}>Private</button><button className={clan.visibility === 'public' ? 'active' : ''} disabled={!!busy} onClick={() => changeVisibility('public')}>Public</button></div><p className="field-note">Public Cults appear in Discover and public rankings. Private Cults require an invite.</p><div className="trade-divider" /></>}
      <h3>Leave cult</h3>
      <p className="field-note">Pending mirrors are cancelled. Open mirrors still unwind when their leader exits.</p>
      {!confirmLeave ? <button className="outline full danger-button" disabled={!!busy} onClick={() => setConfirmLeave(true)}>Leave cult</button> : <><p className="wallet-warning">Leave {clan?.name}? This removes your access to its chart and invite.</p><div className="leave-actions"><button className="outline" disabled={!!busy} onClick={() => setConfirmLeave(false)}>Cancel</button><button className="outline danger-button" disabled={!!busy} onClick={leave}>Confirm leave</button></div></>}
    </div> : null}</aside>}</div>
    {(error || notice) && <div className={`toast ${error ? 'error' : ''}`} role="status">{error ?? notice}<button className="icon-button compact" title="Dismiss" onClick={() => { setError(null); setNotice(null); }}><X size={14} /></button></div>}
    {formOpen && <div className="modal-backdrop"><section className="simple-dialog" role="dialog" aria-modal="true" aria-label={formOpen === 'create' ? 'Create a cult' : 'Join a cult'}><button className="icon-button dialog-close" title="Close" onClick={() => setFormOpen(null)}><X size={16} /></button><span className="eyebrow">{formOpen === 'create' ? 'NEW CULT' : 'INVITATION'}</span><h2>{formOpen === 'create' ? 'Create a cult' : 'Join a cult'}</h2>{formOpen === 'create' ? <><label className="field-label" htmlFor="cult-name">NAME</label><input id="cult-name" value={name} onChange={event => setName(event.target.value)} maxLength={36} placeholder="Name your cult" /><label className="switch-row"><span>Public</span><input type="checkbox" checked={createVisibility === 'public'} onChange={event => setCreateVisibility(event.target.checked ? 'public' : 'private')} /></label><p className="field-note">Auto-follow starts off. Members choose whether to turn it on later.</p><button className="primary full" disabled={!!busy || !name.trim()} onClick={create}>Create cult <ArrowRight size={15} /></button></> : <><label className="field-label" htmlFor="invite-code">INVITE CODE</label><input id="invite-code" value={inviteCode} onChange={event => setInviteCode(formatInviteCode(event.target.value))} autoCapitalize="characters" maxLength={7} placeholder="ABC-DEF" /><p className="field-note">Joining is instant. Auto-follow stays off.</p><button className="primary full" disabled={!!busy || !/^[A-Z]{3}-[A-Z]{3}$/.test(inviteCode)} onClick={join}>Join cult <ArrowRight size={15} /></button></>}</section></div>}
    {depositOpen && <DepositSheet onClose={() => setDepositOpen(false)} />}
    {perpsPrompt && <div className="modal-backdrop"><section className="simple-dialog" role="dialog" aria-modal="true" aria-label="Enable perps"><button className="icon-button dialog-close" title="Close" onClick={() => setPerpsPrompt(false)}><X size={16} /></button><span className="eyebrow">ONE-TIME SETUP</span><h2>Enable perps</h2><p className="field-note">Your wallet signs the account and trading authorization once. You stay in control of your funds.</p><button className="primary full" disabled={!!busy} onClick={enroll}>Enable perps – one time</button>{setup?.step === 'needs_collateral' && <button className="outline full" onClick={() => { setPerpsPrompt(false); setDepositOpen(true); }}>Deposit first</button>}</section></div>}
    {tradeSheetTarget && <TradeSheet target={tradeSheetTarget} onClose={() => setTradeSheetTarget(null)} onProfile={openAccount} onChart={openTradeChart} />}
    {busy && <div className="busy-bar"><span>{busy === 'stack' ? 'Authorizing your trade' : busy === 'join' ? 'Signing cult authorization' : 'Working'}…</span></div>}
  </div>;
}
