'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { useCreateWallet, usePrivy, useSendTransaction, useSignMessage, useSigners, useWallets } from '@privy-io/react-auth';
import { createPublicClient, formatEther, http, isAddress, isHex } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import { ArrowLeft, ArrowRight, CandlestickChart, Compass, Globe2, Home, Link2, Lock, Menu, PanelRightOpen, Plus, Search, Trophy, UserRound, UsersRound, Wallet, X } from 'lucide-react';
import { createClan, createShare, enrollPerpl, getChart, getMarkets, setCountry, getPolicyChallenge, updateClanPolicy, leaveClan, getClanEventUrl, getConfig, getEnrollmentChallenge, getHoldings, getMe, getPerplSetup, getPrivySigner, setUsername, joinClan, setAutoFollowOff, setCultVisibility, openPosition, closePosition, skipAutoMirror, stackPosition, setPositionTpsl, suggestMarkerTpsl, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { DEMO_ADDRESS, demoEnabled, enterDemo, exitDemo, isDemo } from '@/lib/demo';
import type { BackendConfig, ChatMessage, ChartMarker, ChartSnapshot, Holding, MarketListing, Me, MirrorPolicy, SetupStatus, TpslSuggestion, TpslValues, WalletAction } from '@/lib/contracts';
import { cachedList } from '@/lib/marketCache';
import { dollars, price } from '@/lib/format';
import { TokenLogo } from './TokenLogo';
import { Change } from './MarketsView';
import { ClanChat } from './ClanChat';
import { DiscoverCults } from './DiscoverCults';
import { UsernameGate } from './UsernameGate';
import { Leaderboards } from './Leaderboards';
import { HomeView, RoomRow } from './HomeView';
import { AccountView } from './AccountView';
import { TradeSheet, type TradeSheetTarget } from './TradeSheet';
import { GroupPanel } from './GroupPanel';
import { MarketsView } from './MarketsView';
import { MarketPage, type MarketSocial } from './MarketPage';
import { type TicketMarket } from './TradeTicket';
import { RoomBadge } from './RoomBadge';
import { DepositSheet } from './DepositSheet';
import { Landing } from './Landing';
import { TradingPermissionDialog } from './TradingPermissionDialog';
import { Avatar } from './Avatar';
import { SideRail, type NavItem } from './SideRail';
import { Ticker } from './Ticker';
import './dashboard.css';

type View = 'home' | 'chat' | 'discover' | 'account' | 'leaderboards' | 'markets' | 'groups';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
const collateralMessage = (minimumRaw: string) => `Add MON, USDC or AUSD to your wallet to open your perps account (about ${dollars(Number(minimumRaw) / 1e6)}).`;
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
  const privy = usePrivy();
  const { login, logout } = privy;
  const { wallets, ready: walletsReady } = useWallets();
  // Demo mode is read after mounting (it lives in the URL and session storage).
  const [demo, setDemo] = useState<boolean | null>(demoEnabled() ? null : false);
  useEffect(() => { setDemo(isDemo()); }, []);
  const ready = demo === true || privy.ready;
  const authenticated = demo === true || privy.authenticated;
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
  // The chart's candle size, shared by the cult panel and the market page.
  const [chartResolution, setChartResolution] = useState(300);
  // The market page shows a cult's positions (clanId) unless you pick "Off".
  const [marketSolo, setMarketSolo] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const permissionResolve = useRef<((allowed: boolean) => void) | null>(null);
  const decidePermission = (allowed: boolean) => {
    setPermissionOpen(false);
    permissionResolve.current?.(allowed);
    permissionResolve.current = null;
  };
  useEffect(() => () => { permissionResolve.current?.(false); }, []);
  const [createVisibility, setCreateVisibility] = useState<'private' | 'public'>('private');
  const [view, setView] = useState<View>('home');
  const [marketPage, setMarketPage] = useState<string | null>(null);
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railOpenMobile, setRailOpenMobile] = useState(false);
// The rail starts open on every visit; below 1100px it's a drawer instead.
  const toggleRail = () => setRailCollapsed(current => !current);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1100px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const go = (next: View) => { setView(next); setRailOpenMobile(false); };
  const openMarket = (id: string | null) => {
    setMarketPage(id || null);
    go('markets');
    if (id) { setMarketId(id); setSelectedId(null); }
  };
  const [profileId, setProfileId] = useState('me');
  const [tradeSheetTarget, setTradeSheetTarget] = useState<TradeSheetTarget | null>(null);
  const [formOpen, setFormOpen] = useState<'create' | 'join' | null>(null);
  const [search, setSearch] = useState('');
  // The top search: markets (any perp or meme) and your groups, as you type.
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMarkets, setSearchMarkets] = useState<MarketListing[]>([]);
  useEffect(() => {
    const q = search.trim();
    if (!q) { setSearchMarkets([]); return; }
    let active = true;
    const cached = cachedList(q);
    if (cached) setSearchMarkets(cached.slice(0, 8));
    const timer = window.setTimeout(() => {
      getMarkets(q).then(r => { if (active) setSearchMarkets(r.markets.slice(0, 8)); }).catch(() => {});
    }, cached ? 0 : 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== '/' || event.metaKey || event.ctrlKey || target?.closest('input, textarea, select, [contenteditable]')) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [roomId, setRoomId] = useState('global');
  const wallet = wallets.find(item => item.walletClientType === 'privy');
  const walletAddress = demo ? DEMO_ADDRESS : wallet?.address;
  useEffect(() => {
    if (demo || !ready || !authenticated || !walletsReady || wallet || walletCreateAttempted.current) return;
    walletCreateAttempted.current = true;
    void createWallet().catch(reason => setError(errorText(reason)));
  }, [demo, ready, authenticated, walletsReady, wallet, createWallet]);
  const [me, setMe] = useState<Me | null>(null);
  const [clanId, setClanId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChartSnapshot | null>(null);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tpDraft, setTpDraft] = useState('');
  const [slDraft, setSlDraft] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [liveMessage, setLiveMessage] = useState<ChatMessage | null>(null);
  const [stackUsd, setStackUsd] = useState('50');
  const [busy, setBusy] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const seenConversionAt = useRef<Record<string, number>>({});
  // Toasts clear themselves.
  useEffect(() => {
    if (!notice && !error) return;
    const timer = window.setTimeout(() => { setNotice(null); setError(null); }, error ? 9000 : 5000);
    return () => window.clearTimeout(timer);
  }, [notice, error]);
  // New members join their country's room straight away, from where they're
  // connecting (Vercel's IP country). They can change it in Account.
  const countryTried = useRef(false);
  useEffect(() => {
    if (!me || me.country || me.needsUsername || countryTried.current) return;
    countryTried.current = true;
    void (async () => {
      const geo = await fetch('/api/geo').then(r => r.json() as Promise<{ country: string | null }>).catch(() => ({ country: null }));
      if (!geo.country) return;
      const accessToken = await getAccessToken();
      if (!accessToken) return;
      const joined = await setCountry(accessToken, geo.country).catch(() => null);
      if (!joined) return;
      const next = await getMe(accessToken).catch(() => null);
      if (next) setMe(next);
      setNotice(`You're in the ${joined.country.name} room. Change it any time in Account.`);
    })();
  }, [me]);
  useEffect(() => {
    const conversion = me?.usdcConverted;
    if (!me || !conversion || busy || error) return;
    const key = `cult:conversion-seen:${me.id}`;
    let seen = seenConversionAt.current[me.id] ?? 0;
    try {
      const stored = Number(window.localStorage.getItem(key));
      if (Number.isFinite(stored)) seen = Math.max(seen, stored);
    } catch { /* In-memory tracking still prevents duplicate notifications. */ }
    if (conversion.at <= seen) return;
    seenConversionAt.current[me.id] = conversion.at;
    try { window.localStorage.setItem(key, String(conversion.at)); } catch { /* Storage is optional. */ }
    const usdc = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(conversion.usdc);
    setNotice(`Your ${usdc} USDC is now ${dollars(conversion.ausd)} to trade with.`);
  }, [me, busy, error]);
  const clan = me?.clans.find(item => item.id === clanId) ?? snapshot?.clan;
  const activeRoom = me?.rooms.find(item => item.id === roomId);
  const selected = snapshot?.markers.find(item => item.id === selectedId) ?? null;
  const market = snapshot?.selectedMarket;
  const balanceMon = me?.balances?.mon ?? monBalance;
  const gasReserveMon = me?.balances?.gasReserveMon ?? 0.25;
  const lowGas = me?.balances?.lowGas ?? (balanceMon != null && balanceMon < gasReserveMon);
  const signerReady = me?.signer.attached === true && me.signer.policyCurrent === true;
  const signerPrompt = !clanId || signerReady ? null : 'Allow Cult to place your trades';
  useEffect(() => {
    if (!privy.ready || !pendingLogin || privy.authenticated) return;
    const method = pendingLogin;
    setPendingLogin(null);
    login({ loginMethods: [method] });
  }, [privy.ready, pendingLogin, privy.authenticated, login]);
  const requestLogin = (method: 'google' | 'wallet') => {
    if (privy.ready) login({ loginMethods: [method] });
    else setPendingLogin(method);
  };

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
  // Chat activity (every message in a busy room) refreshes the account at most
  // every 10s instead of on each message.
  const lastMeLoad = useRef(0);
  const meLoadTimer = useRef<number | undefined>(undefined);
  const loadMeSoon = useCallback(() => {
    const wait = 10_000 - (Date.now() - lastMeLoad.current);
    if (meLoadTimer.current !== undefined) return;
    meLoadTimer.current = window.setTimeout(() => {
      meLoadTimer.current = undefined;
      lastMeLoad.current = Date.now();
      void loadMe().catch(() => undefined);
    }, Math.max(0, wait));
  }, [loadMe]);
  useEffect(() => () => window.clearTimeout(meLoadTimer.current), []);
  useEffect(() => {
    if (demo || !authenticated || !wallet?.address) return;
    try {
      const cached = window.localStorage.getItem(`cult:me:${wallet.address.toLowerCase()}`);
      if (!cached) return;
      const value = JSON.parse(cached) as Me;
      if (value.address?.toLowerCase() === wallet.address.toLowerCase()) setMe(value);
    } catch { /* Fresh account data will replace the cache. */ }
  }, [demo, authenticated, wallet?.address]);
  const loadChart = useCallback(async (id: string, market?: string) => {
    const result = await getChart(await token(), id, market, chartResolution);
    setSnapshot(result);
    setMarketId(result.selectedMarket.id);
  }, [chartResolution]);
  useEffect(() => {
    if (!authenticated || !ready || demo === null) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadMe().catch(reason => {
        if (reason instanceof ApiError && reason.status === 429) {
          window.clearInterval(interval);
          setError(reason.message);
        }
      });
    }, 20000);
    return () => window.clearInterval(interval);
  }, [authenticated, ready, demo, loadMe]);
  useEffect(() => {
    if (!authenticated || !ready || demo === null) return;
    let active = true;
    Promise.all([loadMe(), getConfig().then(setConfig)]).catch(err => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [authenticated, ready, demo, loadMe]);
  useEffect(() => {
    if (!authenticated || !clanId || demo === null) return;
    let active = true;
    const refresh = () => loadChart(clanId, marketId ?? undefined).catch(err => { if (active) setError(errorText(err)); });
    refresh();
    const interval = window.setInterval(refresh, demo ? 15000 : 30000);
    return () => { active = false; window.clearInterval(interval); };
  }, [authenticated, clanId, marketId, demo, loadChart]);
  useEffect(() => {
    if (demo !== false || !authenticated || !clanId) return;
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
  }, [demo, authenticated, clanId, marketId, loadChart, loadMe]);
  useEffect(() => {
    if (demo || !wallet || config?.chainId !== monadTestnet.id) return;
    let active = true;
    const client = createPublicClient({ chain: monadTestnet, transport: http() });
    const refresh = () => client.getBalance({ address: wallet.address as `0x${string}` })
      .then(value => { if (active) setMonBalance(Number(formatEther(value))); })
      .catch(() => { if (active) setMonBalance(null); });
    refresh();
    const timer = window.setInterval(refresh, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [demo, wallet, config?.chainId]);
  useEffect(() => {
    if (!authenticated || !walletAddress) return;
    let active = true;
    const refresh = () => token().then(getHoldings).then(value => { if (active) setHoldings(value.positions); }).catch(err => { if (active) setError(errorText(err)); });
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [authenticated, walletAddress]);
  useEffect(() => {
    if (!authenticated || demo === null) return;
    // Warm the markets list so Markets, search and trending draw instantly.
    void getMarkets().catch(() => {});
  }, [authenticated, demo]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('invite');
    if (code) { setInviteCode(formatInviteCode(code)); setFormOpen('join'); }
  }, []);
  const perform = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setProgressText(null); setError(null); setNotice(null);
    try { await action(); } catch (err) { setError(errorText(err)); } finally { setBusy(null); setProgressText(null); }
  };
  const sign = async (message: string) => {
    if (demo) return '0xdemo';
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
    if (!demo && !wallet) throw new Error('Create your Privy wallet first.');
    const allowed = await new Promise<boolean>(resolve => {
      permissionResolve.current = resolve;
      setPermissionOpen(true);
    });
    if (!allowed) return false;
    if (demo) { await loadMe(); return true; }
    const value = await getPrivySigner(await token());
    await addSigners({ address: wallet!.address, signers: [{ signerId: value.signerId, policyIds: value.policyIds }] });
    const current = await loadMe();
    if (current.signer.attached !== true || current.signer.policyCurrent !== true) throw new Error('Trading permission is awaiting verification. Try again shortly.');
    return true;
  };
  const enterCult = async (joined: Me['clans'][number]) => {
    await loadMe();
    setClanId(joined.id);
    setRoomId(`cult:${joined.id}`);
    go('chat');
    setSnapshot(null);
    setSelectedId(null);
    window.history.replaceState({}, '', demo ? '/?demo=1' : '/');
  };
  const create = () => perform('create', async () => {
    if (!name.trim()) throw new Error('Name your cult first.');
    const created = await createClan(await token(), name.trim(), createVisibility);
    await enterCult(created);
    setFormOpen(null);
    setName('');
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
  const leave = () => perform('leave', async () => {
    if (!clanId) throw new Error('Choose a cult first.');
    await leaveClan(await token(), clanId);
    const remaining = await loadMe();
    setClanId(remaining.clans[0]?.id ?? null);
    setSnapshot(null);
    setSelectedId(null);
    go('home');
    setNotice('You left the cult. Open mirrors will still unwind when their leader exits.');
  });
  // Turning Auto-follow on and changing its limits are the same signed policy.
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
      } else setNotice(`Auto-follow is on: up to ${dollars(policy.maxUsdPerTrade)} per trade.`);
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
      if (current.step === 'needs_collateral') throw new Error(collateralMessage(current.minAccountOpen));
      if (current.step === 'needs_key') {
        setProgressText('Authorize your perps trading key');
        await wallet.switchChain(config.chainId);
        const challenge = await getEnrollmentChallenge(auth);
        if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('Enrollment challenge expired. Try again.');
        const provider = await wallet.getEthereumProvider();
        const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [wallet.address, JSON.stringify(challenge.typedData)] });
        if (typeof signature !== 'string') throw new Error('Wallet did not return a signature.');
        await enrollPerpl(auth, challenge.challengeId, signature);
      } else {
        if (!current.actions.length) throw new Error('No wallet action is available for this setup step yet.');
        for (const action of current.actions) {
          setProgressText(action.label);
          await transact(action);
        }
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
  const requireNadFunds = (amountUsd: number) => {
    const balances = me?.balances;
    if (!balances && config?.chainId === 143) throw new Error('Wallet balance data is unavailable. Refresh before buying.');
    if (lowGas) throw new Error('MON is too low for gas. Top up your wallet first.');
    // Paid from wallet dollars when they cover it (mainnet), else from MON
    // above the gas reserve, the same rule the backend uses.
    const monPrice = config?.monPriceAusd;
    const mon = balances?.mon ?? monBalance;
    if (mon == null || !monPrice || monPrice <= 0) throw new Error('MON balance or price is unavailable. Wait for it before buying.');
    const dollarsUsable = config?.chainId === 143 || demo ? balances?.walletUsd ?? 0 : 0;
    const monUsable = Math.max(0, mon - gasReserveMon) * monPrice;
    if (Math.max(dollarsUsable, monUsable) < amountUsd) throw new Error(`Not enough funds for this buy (about ${dollars(Math.max(dollarsUsable, monUsable))} available, keeping ${gasReserveMon} MON for fees).`);
  };
  // A trade from a ticket: funds, gas and the one-time perps setup are checked
  // first. cultIds is "Post to": the cults that see it on their chart and copy
  // it (omitted = all, [] = just you).
  const placeMarketTrade = (target: TicketMarket, side: 'long' | 'short' | 'buy', marginUsd: number, leverage: number | undefined, cultIds: string[] | undefined) => perform('open', async () => {
    if (!signerReady && !await grantSigner()) return;
    if (target.venue === 'nadfun') requireNadFunds(marginUsd);
    if (target.venue === 'perpl' && !await ensurePerps()) return;
    setProgressText(target.venue === 'perpl' ? 'Moving funds into your trading account…' : 'Placing your trade…');
    await openPosition(await token(), target.id, target.venue === 'nadfun' ? 'buy' : side, marginUsd, leverage, cultIds);
    setProgressText('Refreshing your positions…');
    if (clanId) await loadChart(clanId, target.id).catch(() => undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    const posted = cultIds?.length === 1 ? me?.clans.find(item => item.id === cultIds[0])?.name : null;
    setNotice(cultIds?.length === 0 ? `Trade placed on ${target.symbol}. Only you see it.` : posted ? `Trade placed on ${target.symbol}, posted to ${posted}.` : `Trade placed on ${target.symbol}, posted to your cults.`);
  });
  // A public PnL card for one of your positions: the phone's share sheet where
  // there is one, otherwise the link is copied and the card opens.
  const shareMarker = (marker: ChartMarker) => perform('share', async () => {
    if (demo) { setNotice('Public PnL cards are created once you sign in.'); return; }
    const result = await createShare(await token(), marker.id, true);
    const url = `${window.location.origin}/share/${encodeURIComponent(result.id)}`;
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ title: `My ${marker.side} on Cult`, url }); return; }
      catch (reason) { if (reason instanceof DOMException && reason.name === 'AbortError') return; }
    }
    await navigator.clipboard.writeText(url).catch(() => undefined);
    window.open(url, '_blank', 'noopener');
    setNotice('PnL card link copied.');
  });
  const closeMarket = (marketToClose: string) => perform('close', async () => {
    await closePosition(await token(), marketToClose);
    setSelectedId(null);
    if (clanId) await loadChart(clanId, marketToClose).catch(() => undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice('Position close submitted.');
  });
  const closeTrade = (holding: Holding) => perform('close', async () => {
    await closePosition(await token(), holding.market);
    if (clanId) await loadChart(clanId, marketId ?? undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice('Position close submitted.');
  });
  const stack = () => perform('stack', async () => {
    if (!clanId || !selected) throw new Error('Select a cult position first.');
    if (selected.isMine) throw new Error('Choose a cult-mate position to stack.');
    const amount = Number(stackUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.');
    if (!signerReady && !await grantSigner()) return;
    if (selected.venue === 'nadfun') requireNadFunds(amount);
    if (selected.venue === 'perpl' && !await ensurePerps()) return;
    const result = await stackPosition(await token(), clanId, selected.id, amount);
    if (result.status !== 'open') throw new Error(result.error ?? 'The stack could not be opened.');
    await loadChart(clanId, marketId ?? undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice('Stacked: the same position is open in your own account.');
  });
  const selectMarker = (marker: ChartMarker) => {
    setSelectedId(marker.id);
    setTpDraft(marker.takeProfitPrice?.toString() ?? '');
    setSlDraft(marker.stopLossPrice?.toString() ?? '');
  };
  const showOnMarketPage = (marker: ChartMarker) => {
    setMarketSolo(false);
    setMarketPage(marker.marketId);
    go('markets');
    selectMarker(marker);
  };
  const openLinkedMarker = (id: string) => perform('open-linked', async () => {
    const onThisChart = snapshot?.markers.find(item => item.id === id);
    if (onThisChart) {
      if (onThisChart.marketId !== snapshot?.selectedMarket.id && clanId) await loadChart(clanId, onThisChart.marketId);
      showOnMarketPage(onThisChart);
      return;
    }
    if (!clanId || !snapshot) throw new Error('Open a cult chart to view this trade.');
    const auth = await token();
    for (const candidate of snapshot.markets) {
      if (candidate.id === snapshot.selectedMarket.id) continue;
      const result = await getChart(auth, clanId, candidate.id);
      const linked = result.markers.find(item => item.id === id);
      if (!linked) continue;
      setSnapshot(result);
      setMarketId(result.selectedMarket.id);
      showOnMarketPage(linked);
      return;
    }
    throw new Error('This linked trade is no longer open on the cult chart.');
  });
  const validateLevel = (marker: ChartMarker, kind: 'takeProfit' | 'stopLoss', level: number) => {
    if (!Number.isFinite(level) || level <= 0) throw new Error('Enter a positive dollar price.');
    const shouldBeAbove = (kind === 'takeProfit') === (marker.side === 'long');
    if (level === marker.markPrice || (level > marker.markPrice) !== shouldBeAbove) {
      throw new Error(`${kind === 'takeProfit' ? 'Take profit' : 'Stop loss'} must be ${shouldBeAbove ? 'above' : 'below'} the current mark.`);
    }
  };
  const submitGuide = (marker: ChartMarker, kind: 'takeProfit' | 'stopLoss', level: number) => perform('tpsl', async () => {
    if (!clanId || marker.venue !== 'perpl' || marker.entryPrice == null) throw new Error('Select an open Perpl position.');
    validateLevel(marker, kind, level);
    const values: TpslValues = kind === 'takeProfit' ? { takeProfit: level } : { stopLoss: level };
    const auth = await token();
    if (marker.isMine) await setPositionTpsl(auth, marker.marketId, values);
    else await suggestMarkerTpsl(auth, clanId, marker.id, values);
    if (selectedId === marker.id) {
      if (kind === 'takeProfit') setTpDraft(String(level)); else setSlDraft(String(level));
    }
    await loadChart(clanId, marketId ?? undefined);
    setNotice(marker.isMine ? `${kind === 'takeProfit' ? 'TP' : 'SL'} set on Perpl.` : `Suggestion sent to ${marker.memberName}.`);
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
    setNotice(selected.isMine ? 'TP/SL set on Perpl.' : `Suggestion sent to ${selected.memberName}.`);
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
    go('chat');
    setGroupPanelOpen(false);
    if (id.startsWith('cult:')) { const next = id.slice(5); if (next !== clanId) { setClanId(next); setSnapshot(null); setSelectedId(null); } }
  };
  const openAccount = (id = 'me') => { setProfileId(id); go('account'); };
  const openTradeChart = (cultId: string, markerId: string, tradeMarket: string) => perform('open-chart', async () => {
    const result = await getChart(await token(), cultId, tradeMarket, chartResolution);
    const marker = result.markers.find(item => item.id === markerId);
    if (!marker) throw new Error('This trade is no longer open on the Cult chart.');
    setClanId(cultId);
    setSnapshot(result);
    setMarketId(result.selectedMarket.id);
    setTradeSheetTarget(null);
    showOnMarketPage(marker);
  });
  const pickMarketCult = (id: string | null) => {
    setSelectedId(null);
    if (!id) { setMarketSolo(true); return; }
    setMarketSolo(false);
    if (id !== clanId) { setClanId(id); setSnapshot(null); }
  };
  const copyInvite = async () => {
    if (!clan) return;
    await navigator.clipboard.writeText(`${window.location.origin}/?invite=${encodeURIComponent(clan.inviteCode)}`).catch(() => undefined);
    setNotice(`Invite link copied. Code ${clan.inviteCode}`);
  };
  const signOut = () => {
    if (demo) { exitDemo(); window.location.assign('/'); return; }
    void logout();
  };

  // The market page asks the cult chart for its own market (once per page).
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${clanId}:${marketPage}`;
    if (view !== 'markets' || !marketPage || marketSolo || !clanId || askedFor.current === key) return;
    askedFor.current = key;
    if (marketPage.toLowerCase() !== marketId?.toLowerCase()) { setMarketId(marketPage); setSelectedId(null); }
  }, [view, marketPage, marketSolo, clanId, marketId]);

  const marketSocial: MarketSocial = {
    cults: me?.clans ?? [],
    cultId: marketSolo ? null : clanId,
    onCult: pickMarketCult,
    snapshot,
    live: liveConnected || !!demo,
    selected,
    onSelect: marker => { if (marker) selectMarker(marker); else setSelectedId(null); },
    onGuideDrop: (marker, kind, level) => { void submitGuide(marker, kind, level); },
    resolution: chartResolution,
    onResolution: setChartResolution,
    now,
    stackUsd, onStackUsd: setStackUsd, onStack: stack,
    tpDraft, slDraft, onTpDraft: setTpDraft, onSlDraft: setSlDraft, onSaveLevels: saveLevels,
    onApplySuggestion: applySuggestion,
    onSkip: skip,
    onClosePosition: closeMarket,
    onShare: shareMarker,
  };
  const searchRooms = useMemo(() => me?.rooms.filter(room => room.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 5) ?? [], [me, search]);

  if (demo === null || !ready || !authenticated) return <Landing onLogin={requestLogin} pendingLogin={pendingLogin} onDemo={demoEnabled() ? () => { enterDemo(); setDemo(true); } : undefined} />;
  if (me?.needsUsername) return <UsernameGate onSave={async username => { await setUsername(await token(), username); await loadMe(); }} />;

  const pickSearch = (action: () => void) => { action(); setSearch(''); setSearchOpen(false); searchRef.current?.blur(); };
  const balance = me?.balances ? me.balances.walletUsd + (me.balances.perplMarginUsd ?? 0) : null;
// Main menu, most used first.
  const nav: NavItem[] = [
    { id: 'home', label: 'Home', icon: <Home size={18} />, active: view === 'home', onClick: () => go('home') },
    { id: 'markets', label: 'Markets', icon: <CandlestickChart size={18} />, active: view === 'markets', onClick: () => openMarket(null) },
    { id: 'discover', label: 'Discover', icon: <Compass size={18} />, active: view === 'discover', onClick: () => go('discover') },
    { id: 'leaderboards', label: 'Leaderboard', icon: <Trophy size={18} />, active: view === 'leaderboards', onClick: () => go('leaderboards') },
  ];
  const collapsed = railCollapsed && !narrow;

  return <div className={`dash ${collapsed ? 'rail-collapsed' : ''} ${railOpenMobile ? 'rail-open' : ''}`}>
    <header className="topbar">
      <button className="icon-btn topbar-menu" title="Menu" onClick={() => setRailOpenMobile(open => !open)}><Menu size={19} /></button>
      <button className="topbar-logo" onClick={() => go('home')} aria-label="Cult home"><img src="/landing/cult-logo.svg" alt="Cult" width={58} height={30} /></button>
      <div className="search">
        <label className="search-box"><Search size={16} /><input ref={searchRef} value={search} onChange={event => { setSearch(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onBlur={() => window.setTimeout(() => setSearchOpen(false), 160)}
          onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); event.currentTarget.blur(); } if (event.key === 'Enter' && searchMarkets[0] && view !== 'markets') pickSearch(() => openMarket(searchMarkets[0]!.id)); }}
          placeholder="Search markets, memes, cults" aria-label="Search markets, memes or cults" /><kbd>/</kbd></label>
        {searchOpen && search.trim() && view !== 'markets' && <div className="search-drop" role="listbox">
          {searchMarkets.length > 0 && <><span className="search-label">Markets</span>{searchMarkets.map(item => <button key={`${item.venue}:${item.id}`} role="option" aria-selected={false} onMouseDown={event => event.preventDefault()} onClick={() => pickSearch(() => openMarket(item.id))}>
            <TokenLogo symbol={item.symbol} imageUri={item.imageUri} /><span className="search-name"><strong>{item.symbol}</strong><small>{item.venue === 'perpl' ? `Perp · up to ${Math.floor(item.maxLeverage)}x` : item.name}</small></span>
            <span className="search-price"><strong className="num">{price(item.priceUsd)}</strong><Change pct={item.change24hPct} /></span></button>)}</>}
          {searchRooms.length > 0 && <><span className="search-label">Cults &amp; rooms</span>{searchRooms.map(room => <button key={room.id} role="option" aria-selected={false} onMouseDown={event => event.preventDefault()} onClick={() => pickSearch(() => openRoom(room.id))}><RoomBadge icon={room.icon} kind={room.kind} size="sm" /><span className="search-name"><strong>{room.name}</strong><small>{room.memberCount} members</small></span></button>)}</>}
          {!searchMarkets.length && !searchRooms.length && <p className="search-empty">Nothing matches &ldquo;{search.trim()}&rdquo; yet.</p>}
        </div>}
      </div>
      <div className="topbar-right">
        {demo && <span className="demo-pill" title="Sample data. Nothing here touches real funds.">Demo</span>}
        <button className="balance" onClick={() => setDepositOpen(true)} title="Wallet and trading account"><i />{balance == null ? '—' : <span className="num">{dollars(balance)}</span>}</button>
        <button className="btn btn-primary btn-sm topbar-deposit" onClick={() => setDepositOpen(true)}><Wallet size={15} /> Deposit</button>
        <button className="topbar-me" onClick={() => openAccount()} title="Account"><Avatar name={me?.name ?? 'You'} url={me?.avatarUrl} /></button>
      </div>
    </header>

    <SideRail me={me} nav={nav} collapsed={collapsed} onToggle={toggleRail} activeRoom={view === 'chat' ? roomId : null} activeMarket={view === 'markets' ? marketPage : null}
      onRoom={openRoom} onMarket={id => openMarket(id)} onCreate={() => setFormOpen('create')} onJoin={() => setFormOpen('join')} />
    {railOpenMobile && <button className="rail-scrim" aria-label="Close panel" onClick={() => setRailOpenMobile(false)} />}

    <main className="stage" key={view === 'chat' ? `chat:${roomId}` : view === 'markets' ? `m:${marketPage ?? ''}` : view === 'account' ? `a:${profileId}` : view}>
      {!me ? <div className="view two-col"><section className="view-main"><div className="skel skel-head" /><div className="skel skel-strip" /><div className="skel skel-chart" /></section><aside className="view-side"><div className="skel skel-card" /><div className="skel skel-card" /></aside></div>
        : view === 'home' ? <HomeView me={me} holdings={holdings} search={search} onMarket={openMarket} onRoom={openRoom} onProfile={openAccount} onTrade={trade => setTradeSheetTarget(trade.tradeId ? { kind: 'trade', tradeId: trade.tradeId } : { kind: 'home', trade })} onDeposit={() => setDepositOpen(true)} onCreate={() => setFormOpen('create')} onDiscover={() => go('discover')} />
        : view === 'markets' ? (marketPage ? <MarketPage id={marketPage} me={me} config={config} busy={busy} social={marketSocial} holdings={holdings} onBack={() => openMarket(null)} onTrade={placeMarketTrade} onDeposit={() => setDepositOpen(true)} onProfile={openAccount} /> : <MarketsView search={search} onOpen={openMarket} />)
        : view === 'groups' ? <div className="view one-col"><section className="view-main"><header className="page-head"><div><span className="eyebrow">Your cults</span><h1 className="display">Cults</h1></div><div className="page-actions"><button className="btn btn-ghost btn-sm" onClick={() => setFormOpen('join')}><Link2 size={15} /> Invite code</button><button className="btn btn-primary btn-sm" onClick={() => setFormOpen('create')}><Plus size={15} /> Create</button></div></header><div className="card flush">{me.rooms.filter(room => room.name.toLowerCase().includes(search.trim().toLowerCase())).map(room => <RoomRow key={room.id} room={room} onOpen={() => openRoom(room.id)} />)}</div></section></div>
        : view === 'discover' ? <DiscoverCults busy={!!busy} onJoin={joinPublic} country={me.country ?? null} cultId={clanId} onProfile={openAccount} search={search} onCreate={() => setFormOpen('create')} onInvite={() => setFormOpen('join')} />
        : view === 'leaderboards' ? <Leaderboards country={me.country ?? null} cultId={clanId} onProfile={openAccount} />
        : view === 'account' ? <AccountView id={profileId} holdings={holdings} onCloseHolding={closeTrade} onCountrySaved={loadMe} onDeposit={() => setDepositOpen(true)} onSignOut={signOut} signOutLabel={demo ? 'Exit demo' : 'Sign out'} onTrade={setTradeSheetTarget} onAvatarSaved={loadMe} onRoom={openRoom} />
        : <div className="view two-col room-view">
          <section className="view-main room-main">
            <div className="room-mobile"><button className="icon-btn" title="Back to cults" onClick={() => go('groups')}><ArrowLeft size={18} /></button><span>{activeRoom && <RoomBadge icon={activeRoom.icon} kind={activeRoom.kind} size="sm" />}{activeRoom?.name ?? 'Room'}</span><button className="btn btn-ghost btn-sm" onClick={() => setGroupPanelOpen(true)}><PanelRightOpen size={14} /> {activeRoom?.kind === 'cult' ? 'Positions' : 'Rankings'}</button></div>
            {activeRoom ? <ClanChat key={activeRoom.id} room={activeRoom} liveMessage={activeRoom.kind === 'cult' ? liveMessage : null} selectedMarker={activeRoom.kind === 'cult' ? selected : null} onOpenMarker={openLinkedMarker} onMember={openAccount} onActivity={loadMeSoon} onInvite={activeRoom.kind === 'cult' ? copyInvite : undefined} canPin={!!clan?.isOwner && activeRoom.kind === 'cult'} meId={me.id} markers={activeRoom.kind === 'cult' ? snapshot?.markers : undefined}
              onTrade={activeRoom.kind === 'cult' ? () => { setMarketSolo(false); openMarket(market?.id ?? snapshot?.markets[0]?.id ?? null); } : () => openMarket(null)} />
              : <div className="empty"><strong>This room is unavailable.</strong><span>Refresh your account or choose a country in Account.</span></div>}
          </section>
          {activeRoom && <div className={`view-side room-side ${groupPanelOpen ? 'open' : ''}`}>
            <button className="sheet-close" onClick={() => setGroupPanelOpen(false)}><X size={16} /> Close</button>
            <GroupPanel room={activeRoom} cult={activeRoom.kind === 'cult' ? clan ?? null : null} config={config} snapshot={activeRoom.kind === 'cult' ? snapshot : null} selected={activeRoom.kind === 'cult' ? selected : null} busy={!!busy} signerPrompt={signerPrompt}
              onGrantSigner={() => { void perform('grant-signer', async () => { const confirmed = await grantSigner(); setNotice(confirmed ? 'Trading signer is active.' : 'Signer approval is awaiting Privy verification.'); }); }}
              onFollowOn={enableAutoFollow} onFollowOff={disableAutoFollow} onMarket={id => { setMarketId(id); setSelectedId(null); }} onMarker={selectMarker}
              onOpenTrade={() => { if (market) { setMarketSolo(false); setMarketPage(market.id); go('markets'); } }} onGuideDrop={(marker, kind, level) => { void submitGuide(marker, kind, level); }}
              onInvite={copyInvite} onVisibility={changeVisibility} onLeave={leave} onProfile={openAccount} />
          </div>}
          {groupPanelOpen && <button className="sheet-scrim" aria-label="Close details" onClick={() => setGroupPanelOpen(false)} />}
        </div>}
    </main>

    <Ticker live={liveConnected} demo={!!demo} onMarket={id => openMarket(id)} onExitDemo={signOut} />

    <nav className="tabbar" aria-label="Mobile navigation">
      <button className={view === 'home' ? 'on' : ''} onClick={() => go('home')}><Home size={20} /><span>Home</span></button>
      <button className={view === 'markets' ? 'on' : ''} onClick={() => openMarket(null)}><CandlestickChart size={20} /><span>Markets</span></button>
      <button className={['groups', 'chat'].includes(view) ? 'on' : ''} onClick={() => { setGroupPanelOpen(false); go('groups'); }}><UsersRound size={20} /><span>Cults</span></button>
      <button className={view === 'discover' || view === 'leaderboards' ? 'on' : ''} onClick={() => go('discover')}><Compass size={20} /><span>Discover</span></button>
      <button className={view === 'account' ? 'on' : ''} onClick={() => openAccount()}><UserRound size={20} /><span>Account</span></button>
    </nav>

    {(error || notice) && <div className={`toast ${error ? 'is-error' : ''}`} role="status"><span>{error ?? notice}</span><button className="icon-btn icon-btn--sm" title="Dismiss" onClick={() => { setError(null); setNotice(null); }}><X size={14} /></button></div>}

    {formOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setFormOpen(null); }}>
      <section className="dialog cult-dialog" role="dialog" aria-modal="true" aria-label={formOpen === 'create' ? 'Create a cult' : 'Join a cult'}>
        <button className="icon-btn dialog-close" title="Close" onClick={() => setFormOpen(null)}><X size={16} /></button>
        <div className="dialog-switch seg seg--sm"><button className={formOpen === 'create' ? 'on' : ''} onClick={() => setFormOpen('create')}>Create</button><button className={formOpen === 'join' ? 'on' : ''} onClick={() => setFormOpen('join')}>Join</button></div>
        {formOpen === 'create' ? <>
          <div className="cult-preview"><span className="cult-preview-badge">{name.trim()[0]?.toUpperCase() ?? 'C'}</span><span><strong>{name.trim() || 'Your cult'}</strong><small>{createVisibility === 'public' ? 'Public · listed in Discover' : 'Private · invite only'}</small></span></div>
          <h2 className="display">Create a cult</h2>
          <p className="dialog-sub">Trade together. Every member&apos;s position shows on one chart, with live PnL.</p>
          <label className="field"><span className="field-top"><span>Name</span><small>{name.length}/36</small></span><input id="cult-name" value={name} onChange={event => setName(event.target.value)} maxLength={36} placeholder="Night Shift" autoFocus onKeyDown={event => { if (event.key === 'Enter' && name.trim()) create(); }} /></label>
          <div className="choices" role="radiogroup" aria-label="Visibility">
            <button role="radio" aria-checked={createVisibility === 'private'} className={createVisibility === 'private' ? 'on' : ''} onClick={() => setCreateVisibility('private')}><Lock size={17} /><span><strong>Private</strong><small>Only people with your invite can join</small></span></button>
            <button role="radio" aria-checked={createVisibility === 'public'} className={createVisibility === 'public' ? 'on' : ''} onClick={() => setCreateVisibility('public')}><Globe2 size={17} /><span><strong>Public</strong><small>Listed in Discover and public rankings</small></span></button>
          </div>
          <p className="fine">Auto-follow starts off. Members choose whether to copy trades, and how much.</p>
          <button className="btn btn-primary btn-block btn-lg" disabled={!!busy || !name.trim()} onClick={create}>Create cult <ArrowRight size={16} /></button>
        </> : <>
          <h2 className="display">Join a cult</h2>
          <p className="dialog-sub">Paste an invite link or type the six-letter code a friend sent you.</p>
          <label className="field"><span className="field-top"><span>Invite code</span></span><input id="invite-code" className="code-input" value={inviteCode} onChange={event => setInviteCode(formatInviteCode(event.target.value))} autoCapitalize="characters" maxLength={7} placeholder="ABC-DEF" autoFocus onKeyDown={event => { if (event.key === 'Enter' && /^[A-Z]{3}-[A-Z]{3}$/.test(inviteCode)) join(); }} /></label>
          <p className="fine">Joining is instant. Auto-follow stays off until you turn it on.</p>
          <button className="btn btn-primary btn-block btn-lg" disabled={!!busy || !/^[A-Z]{3}-[A-Z]{3}$/.test(inviteCode)} onClick={join}>Join cult <ArrowRight size={16} /></button>
          <button className="btn btn-ghost btn-block" onClick={() => { setFormOpen(null); go('discover'); }}><Compass size={15} /> Browse public cults</button>
        </>}
      </section>
    </div>}
    {depositOpen && <DepositSheet onClose={() => setDepositOpen(false)} signerReady={signerReady} permissionBusy={!!busy} onGrantPermission={() => { void perform('grant-signer', async () => { if (await grantSigner()) setNotice('Trading permission is active.'); }); }} />}
    {permissionOpen && <TradingPermissionDialog onDecision={decidePermission} />}
    {perpsPrompt && <div className="modal-backdrop"><section className="dialog simple-dialog" role="dialog" aria-modal="true" aria-label="Enable perps"><button className="icon-btn dialog-close" title="Close" disabled={busy === 'enroll-perpl'} onClick={() => setPerpsPrompt(false)}><X size={16} /></button><span className="eyebrow">One-time setup</span><h2 className="display">Enable perps</h2><p className="dialog-sub">Your wallet signs the account and trading authorization once. You stay in control of your funds.</p>{progressText && busy === 'enroll-perpl' && <p className="fine" role="status">{progressText}</p>}<button className="btn btn-primary btn-block btn-lg" disabled={!!busy} onClick={enroll}>Enable perps</button>{setup?.step === 'needs_collateral' && <><p className="fine">{collateralMessage(setup.minAccountOpen)}</p><button className="btn btn-ghost btn-block" onClick={() => { setPerpsPrompt(false); setDepositOpen(true); }}>Deposit first</button></>}</section></div>}
    {tradeSheetTarget && <TradeSheet target={tradeSheetTarget} onClose={() => setTradeSheetTarget(null)} onProfile={openAccount} onChart={openTradeChart} />}
    {busy && !permissionOpen && <div className="busy" role="status"><i /><span>{progressText ?? (busy === 'stack' ? 'Authorizing your trade…' : busy === 'open' ? 'Placing your trade…' : 'Working…')}</span></div>}
  </div>;
}
