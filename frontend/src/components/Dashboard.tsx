'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { useCreateWallet, usePrivy, useSendTransaction, useSignMessage, useSignTypedData, useSigners, useWallets } from '@privy-io/react-auth';
import { createPublicClient, formatEther, http, isAddress, isHex } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import { ArrowLeft, ArrowRight, CandlestickChart, Compass, Globe2, Home, Link2, Lock, PanelRightOpen, Plus, Search, Trophy, UserRound, UsersRound, X } from './icons';
import { createClan, createShare, enrollPerpl, ensureGas, setCultAdmin, getChart, getMarkets, setCountry, setPin, resetPin, getPolicyChallenge, updateClanPolicy, leaveClan, getClanEventUrl, getConfig, getEnrollmentChallenge, getHoldings, getMe, getPerplSetup, getPrivySigner, setUsername, joinClan, setAutoFollowOff, setCultVisibility, openPosition, closePosition, skipAutoMirror, stackPosition, setPositionTpsl, suggestMarkerTpsl, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { DEMO_ADDRESS, demoEnabled, enterDemo, exitDemo, isDemo } from '@/lib/demo';
import { privySupported } from '@/lib/privySupport';
import { BOOT_CLASS, PIN_RESET_KEY, hasStoredSession, markSession } from '@/lib/session';
import { signsQuietly } from '@/lib/quietSign';
import type { BackendConfig, ChatMessage, ChartMarker, ChartSnapshot, Fill, Holding, MarketListing, Me, MirrorPolicy, SetupStatus, TpslSuggestion, TpslValues, WalletAction } from '@/lib/contracts';
import { cachedList } from '@/lib/marketCache';
import { dollars, messageLine, price, shortAddress } from '@/lib/format';
import { validateMirrorPolicy } from '@/lib/mirrorPolicy';
import { tradeAudienceNotice } from '@/lib/tradeAudience';
import { copyFailureFromEvent, perpsCopyReady, type CopyFailure } from '@/lib/copyStatus';
import { availableTradeFunds } from '@/lib/tradeFunds';
import { disablePhonePush } from '@/lib/phonePush';
import { TokenLogo } from './TokenLogo';
import { Change } from './MarketsView';
import { ClanChat } from './ClanChat';
import { DiscoverCults } from './DiscoverCults';
import { UsernameGate } from './UsernameGate';
import { PinGate } from './PinGate';
import { Leaderboards } from './Leaderboards';
import { HomeView, RoomRow, UnreadBubble, latestFirst } from './HomeView';
import { AccountView } from './AccountView';
import { TradeSheet, type TradeSheetTarget } from './TradeSheet';
import { GroupPanel } from './GroupPanel';
import { MarketsView, currentMarketsTab, showMarketsTab } from './MarketsView';
import { MarketPage, type MarketSocial } from './MarketPage';
import { type TicketMarket } from './TradeTicket';
import { RoomBadge } from './RoomBadge';
import { DepositSheet } from './DepositSheet';
import { WithdrawSheet } from './WithdrawSheet';
import { PnlCardSheet, type PnlSheetMode } from './PnlCardSheet';
import { PredictionPage } from './PredictionPage';
import { EventArt, type PredictionPick } from './PredictionsBrowse';
import { CATEGORIES, chance, listEvents, type PredictionEvent } from '@/lib/polymarket';
import { resultOfClose, resultOfMarker, resultOfPrediction, resultOfSale, type TradeResult } from '@/lib/pnlCard';
import { buyPrediction, sellPrediction, getPredictionAccount, setupPredictions, signFlowStep, pollFlow, isFlowStep, redeemPrediction, fundPredictions, withdrawPredictions } from '@/lib/api';
import type { FlowStep, PredictionAccount, PredictionOrder, PredictionPosition, SignatureRequest } from '@/lib/contracts';
import { Landing } from './Landing';
import { AlertsMenu, notifyDevice } from './AlertsMenu';
import { lastReadOf, markRead, mentions, notifyPref, priceAlerts, pushAlert, removePriceAlert, setMentioned, setUnread, unreadOf, useMentions, useUnread } from '@/lib/prefs';
import { getRoomMessages } from '@/lib/api';
import { TradingPermissionDialog } from './TradingPermissionDialog';
import { Avatar } from './Avatar';
import { SideRail, type NavItem } from './SideRail';
import { Ticker } from './Ticker';
import { parseRoute, routePath, type AccountTab, type Route, type View } from '@/lib/routes';
import './dashboard.css';

const errorText = (error: unknown) => {
  const text = error instanceof Error ? error.message : 'Something went wrong.';
  if (error instanceof ApiError) return text;
  // A wallet that can't pay a network fee: one plain line, not the raw wallet error.
  return /insufficient (balance|funds)/i.test(text) ? 'Top up MON for gas.' : text;
};
const PREDICTIONS_UNAVAILABLE = 'Predictions are being switched on. Check back soon.';
const collateralMessage = (minimumRaw: string, chainId?: number) => chainId === 143
  ? `Add MON, USDC or AUSD to your wallet to open your perps account (about ${dollars(Number(minimumRaw) / 1e6)}).`
  : `Your perps account needs about ${dollars(Number(minimumRaw) / 1e6)} in testnet dollars. MON and testnet USDC cannot be converted to perps margin on testnet.`;
const inviteFromInput = (input: string) => {
  try { return new URL(input).searchParams.get('invite') ?? input.trim(); }
  catch { return input.trim(); }
};
const formatInviteCode = (input: string) => {
  const letters = inviteFromInput(input).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  return letters.length > 3 ? `${letters.slice(0, 3)}-${letters.slice(3)}` : letters;
};

// Everything the dashboard needs from Privy, in one place, so it can also run
// where Privy can't (see privySupport).
function usePrivyAuth() {
  const privy = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  const { sendTransaction } = useSendTransaction();
  const { addSigners } = useSigners();
  return { ready: privy.ready, authenticated: privy.authenticated, login: privy.login, logout: privy.logout, wallets, walletsReady, createWallet, signMessage, signTypedData, sendTransaction, addSigners };
}
type PrivyAuth = ReturnType<typeof usePrivyAuth>;
const SECURE_ONLY = 'Sign-in needs a secure connection (https or localhost). On this device, use "Explore the demo".';
const needsSecure = () => { throw new Error(SECURE_ONLY); };
const NO_PRIVY = {
  ready: true, authenticated: false, login: () => window.alert(SECURE_ONLY), logout: async () => {},
  wallets: [], walletsReady: true, createWallet: needsSecure, signMessage: needsSecure, signTypedData: needsSecure, sendTransaction: needsSecure, addSigners: needsSecure,
} as unknown as PrivyAuth;

type Hints = { demoHint: boolean; sessionHint: boolean };
function WithPrivy(hints: Hints) { return <DashboardView privy={usePrivyAuth()} {...hints} />; }

// Part of a position: its size, value and PnL scaled to the share closed.
const scaleHolding = (holding: Holding, share: number): Holding => share >= 1 ? holding
  : { ...holding, size: holding.size * share, valueAusd: holding.valueAusd * share, pnlAusd: holding.pnlAusd == null ? null : holding.pnlAusd * share };

// TP/SL field text: six significant digits, not a dragged line's raw float.
const levelDraft = (value: number | null | undefined) => value == null ? '' : String(Number(value.toPrecision(6)));

// Both hints mean "show the splash, not the landing page, while loading":
// demoHint, the URL asked for the demo (?demo=1); sessionHint, this browser
// was signed in last time (lib/session).
export function Dashboard({ demoHint = false, sessionHint = false }: Partial<Hints>) {
  return privySupported() ? <WithPrivy demoHint={demoHint} sessionHint={sessionHint} /> : <DashboardView privy={NO_PRIVY} demoHint={demoHint} sessionHint={sessionHint} />;
}

function DashboardView({ privy, demoHint, sessionHint }: { privy: PrivyAuth } & Hints) {
  const { login, logout, wallets, walletsReady, createWallet, signMessage, signTypedData, sendTransaction, addSigners } = privy;
  // Demo mode is read after mounting (it lives in the URL and session storage).
  const [demo, setDemo] = useState<boolean | null>(demoEnabled() ? null : false);
  // Read before the first paint, with whether Privy left a session here, so
  // a signed-in reload goes straight to the splash.
  const [expectSession, setExpectSession] = useState(sessionHint);
  const [booted, setBooted] = useState(false);
  // "Forgot PIN" signs out; the fresh sign-in after it sets a new PIN.
  const [pinReset, setPinReset] = useState(false);
  useLayoutEffect(() => {
    setDemo(isDemo());
    if (hasStoredSession()) setExpectSession(true);
    setBooted(true);
  }, []);
  useEffect(() => { if (booted) document.documentElement.classList.remove(BOOT_CLASS); }, [booted]);
  // Read on every sign-in and sign-out ("Forgot PIN" signs out without a reload).
  useEffect(() => { try { setPinReset(window.sessionStorage.getItem(PIN_RESET_KEY) === '1'); } catch { /* no reset pending */ } }, [privy.authenticated]);
  // Remember for the server whether this browser is signed in.
  useEffect(() => { if (privy.ready && demo === false) markSession(privy.authenticated); }, [privy.ready, privy.authenticated, demo]);
  const ready = demo === true || privy.ready;
  const authenticated = demo === true || privy.authenticated;
  const walletCreateAttempted = useRef(false);
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
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // The PnL card shown after a close.
  // The PnL card sheet: after a close or sale, a live position shared from the chart, or a close waiting for confirmation.
  const [cardSheet, setCardSheet] = useState<{ result: TradeResult; mode: PnlSheetMode; confirmLabel?: string; onConfirm?: (share: number) => void; onShareLink?: () => void; closeHolding?: Holding } | null>(null);
  // Before a close: the share of the position to close (1 = all).
  const [closeShare, setCloseShare] = useState(1);
  // Prediction markets: the outcome/side picked from a card, and a counter
  // that tells their views to reload positions after a trade.
  const [predictionPick, setPredictionPick] = useState<PredictionPick | null>(null);
  const [predictionRev, setPredictionRev] = useState(0);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const permissionResolve = useRef<((allowed: boolean) => void) | null>(null);
  const decidePermission = (allowed: boolean) => {
    setPermissionOpen(false);
    permissionResolve.current?.(allowed);
    permissionResolve.current = null;
  };
  useEffect(() => () => { permissionResolve.current?.(false); }, []);
  const [createVisibility, setCreateVisibility] = useState<'private' | 'public'>('private');
  // The page comes from the URL (see lib/routes), so back and forward move
  // between pages, and a page can be refreshed or linked.
  const pathname = usePathname();
  const route = useMemo(() => parseRoute(pathname) ?? parseRoute('/')!, [pathname]);
  const { view, market: marketPage, profile: profileId, tab: accountTab } = route;
  const roomId = route.room ?? 'global';
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  useEffect(() => { setGroupPanelOpen(false); }, [pathname]);
  // A new history entry per page. Each remembers the page it came from, so a
  // page's own back arrow can step back instead of stacking another entry.
  const navigate = (next: Partial<Route> & { view: View }, replace = false) => {
    const url = routePath(next) + (demo ? '?demo=1' : '');
    if (url === window.location.pathname + window.location.search) return;
    if (replace) window.history.replaceState({ cultFrom: window.history.state?.cultFrom ?? null }, '', url);
    else window.history.pushState({ cultFrom: window.location.pathname }, '', url);
  };
  const go = (next: View) => navigate({ view: next });
  const goUp = (parent: Partial<Route> & { view: View }) => {
    if (window.history.state?.cultFrom === routePath(parent)) window.history.back();
    else navigate(parent);
  };
  const openMarket = (id: string | null) => {
    navigate({ view: 'markets', market: id || null });
    if (id) { setMarketId(id); setSelectedId(null); }
  };
  // Prediction pages share the market slot as "pm:<event slug>"; they have no cult chart.
  const openPrediction = (slug: string, pick?: PredictionPick) => { setPredictionPick(pick ?? null); navigate({ view: 'markets', market: `pm:${slug}` }); };
  const [tradeSheetTarget, setTradeSheetTarget] = useState<TradeSheetTarget | null>(null);
  const [formOpen, setFormOpen] = useState<'create' | 'join' | null>(null);
  const [search, setSearch] = useState('');
  // The top search: markets (any perp or meme) and your groups, as you type.
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [marketsTab, setMarketsTab] = useState(currentMarketsTab); // the Markets screen's section
  const [searchMarkets, setSearchMarkets] = useState<MarketListing[]>([]);
  useEffect(() => {
    const q = search.trim();
    if (!q) { setSearchMarkets([]); return; }
    let active = true;
    const cached = cachedList(q);
    if (cached) setSearchMarkets(cached.slice(0, 24));
    const timer = window.setTimeout(() => {
      getMarkets(q).then(r => { if (active) setSearchMarkets(r.markets.slice(0, 24)); }).catch(() => {});
    }, cached ? 0 : 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search]);
  // Prediction markets for the search too: the busiest live events, matched by title or outcome.
  const [searchPredictions, setSearchPredictions] = useState<PredictionEvent[]>([]);
  useEffect(() => {
    const q = search.trim().toLowerCase();
    if (!q) { setSearchPredictions([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      listEvents(CATEGORIES[0]!).then(events => {
        if (active) setSearchPredictions(events.filter(e => e.title.toLowerCase().includes(q) || e.outcomes.some(o => o.label.toLowerCase().includes(q))).slice(0, 5));
      }).catch(() => {});
    }, 180);
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
  const [copyFailure, setCopyFailure] = useState<CopyFailure | null>(null);
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
  // Alerts, watched while Cult is open. Price alerts fire once and are
  // removed; cult alerts come from each cult room's latest message (the first
  // look only takes note of what's there, so old trades don't alert).
  const owner = me?.id ?? null;
  const alertNow = useCallback((title: string, body: string) => { setNotice(`${title}. ${body}`); if (owner) notifyDevice(owner, title, body); }, [owner]);
  useEffect(() => {
    if (!owner || !authenticated || demo === null) return;
    let active = true;
    const check = async () => {
      if (!priceAlerts(owner).length) return;
      const markets = (await getMarkets().catch(() => null))?.markets;
      if (!active || !markets) return;
      for (const alert of priceAlerts(owner)) {
        const now = markets.find(m => m.id === alert.marketId)?.priceUsd;
        if (now == null || (alert.direction === 'above' ? now < alert.price : now > alert.price)) continue;
        removePriceAlert(owner, alert.id);
        const title = `${alert.symbol} ${alert.direction === 'above' ? 'rose above' : 'fell below'} ${price(alert.price)}`;
        const body = `Now ${price(now)}`;
        pushAlert(owner, { kind: 'price', title, body, marketId: alert.marketId });
        alertNow(title, body);
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 20_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [owner, authenticated, demo, alertNow]);
  const seenCultMessage = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (!me) return;
    const first = seenCultMessage.current == null;
    const seen = seenCultMessage.current ??= {};
    for (const room of me.rooms) {
      const last = room.lastMessage;
      if (room.kind !== 'cult' || !last || seen[room.id] === last.id) continue;
      seen[room.id] = last.id;
      if (first || last.kind !== 'system') continue;
      // A cult-mate's new trade, or auto-follow copying one into your account.
      const copied = last.memberId === me.id && /^auto-copied /.test(last.body);
      if (!copied && (last.memberId === me.id || !/^(opened|bought) /.test(last.body))) continue;
      const title = copied ? last.body.replace(/^auto-copied /, 'Auto-follow copied ') : `${last.memberName} ${last.body}`;
      pushAlert(me.id, { kind: 'cult', title, body: room.name, roomId: room.id });
      alertNow(title, `In ${room.name}`);
    }
  }, [me, alertNow]);
  // Unread messages in your cults. When a room's latest message is new, its
  // messages since you last read it (on this device) are counted; opening the
  // room reads it, and so does sending in it. With notifications on, a new
  // message from someone else also alerts. An @mention of you always alerts.
  const openRoomId = view === 'chat' ? roomId : null;
  const countedMessage = useRef<Record<string, string>>({});
  const unread = useUnread(owner ?? 'signed-out');
  const mentioned = useMentions(owner ?? 'signed-out');
  useEffect(() => {
    if (!me) return;
    const owner = me.id;
    for (const room of me.rooms) {
      if (room.kind !== 'cult') continue;
      const last = room.lastMessage;
      const read = lastReadOf(owner)[room.id];
      // A room seen for the first time on this device starts out read.
      // Typing in a room reads it; your own trade notices (opened, auto-copied) don't.
      if (!read || room.id === openRoomId || (last?.memberId === owner && last.kind === 'text')) {
        if (last || !read) markRead(owner, room.id, last?.createdAt ?? new Date().toISOString());
        continue;
      }
      if (!last || Date.parse(last.createdAt) <= Date.parse(read) || countedMessage.current[room.id] === last.id) continue;
      countedMessage.current[room.id] = last.id;
      void token().then(t => getRoomMessages(t, room.id)).then(page => {
        const since = Date.parse(lastReadOf(owner)[room.id] ?? last.createdAt);
        const fresh = page.messages.filter(m => m.memberId !== owner && Date.parse(m.createdAt) > since);
        const before = unreadOf(owner)[room.id] ?? 0;
        setUnread(owner, room.id, fresh.length);
        const mention = fresh.slice(before).filter(m => m.kind === 'text' && mentions(m.body, me.name)).at(-1);
        if (mention) {
          setMentioned(owner, room.id, true);
          const title = `${mention.memberName} mentioned you in ${room.name}`;
          pushAlert(owner, { kind: 'cult', title, body: mention.body, roomId: room.id });
          alertNow(title, mention.body);
          return;
        }
        const newest = fresh.at(-1);
        if (fresh.length > before && newest?.kind === 'text' && notifyPref(owner)) {
          const title = `${newest.memberName} in ${room.name}`;
          pushAlert(owner, { kind: 'cult', title, body: messageLine(newest), roomId: room.id });
          alertNow(title, messageLine(newest));
        }
      }).catch(() => undefined);
    }
  }, [me, openRoomId, alertNow]);
  const unreadTotal = Object.values(unread).reduce((sum, n) => sum + n, 0);
  const mentionedAny = Object.values(mentioned).some(Boolean);
  // The desktop search sits in the true center: both side columns of the top
  // bar are kept at least as wide as the wider of its two sides.
  const topbarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const bar = topbarRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const sides = [bar.querySelector<HTMLElement>('.topbar-logo'), bar.querySelector<HTMLElement>('.topbar-right')].filter((el): el is HTMLElement => !!el);
    const fit = () => bar.style.setProperty('--topbar-side', `${Math.ceil(Math.max(...sides.map(el => el.offsetWidth)))}px`);
    const observer = new ResizeObserver(fit);
    sides.forEach(el => observer.observe(el));
    fit();
    return () => observer.disconnect();
  }, [me, demo, authenticated]);
  // New members join their country's room straight away, from where they're
  // connecting (Vercel's IP country).
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
      setNotice(`You're in the ${joined.country.name} room.`);
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
  // A new account's wallet is made just after sign-in: load the account once
  // it exists, and if the backend is a moment behind (409), quietly try again.
  const hasWallet = !!wallet;
  useEffect(() => {
    if (!authenticated || !ready || demo === null || (!demo && !hasWallet)) return;
    let active = true;
    let retry: number | undefined;
    const load = (attempt: number) => Promise.all([loadMe(), getConfig().then(setConfig)]).catch(err => {
      if (!active) return;
      if (err instanceof ApiError && err.status === 409 && attempt < 10) { retry = window.setTimeout(() => void load(attempt + 1), 2000); return; }
      setError(errorText(err));
    });
    void load(0);
    return () => { active = false; window.clearTimeout(retry); };
  }, [authenticated, ready, demo, hasWallet, loadMe]);
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
        if (message.event === 'mirror' || message.event === 'adjustment') {
          const failure = copyFailureFromEvent(message.data, me?.id, clanId);
          if (failure) { setCopyFailure(failure); setError(`Your copy did not run: ${failure.reason}`); }
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
  }, [demo, authenticated, clanId, marketId, loadChart, loadMe, me?.id]);
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
    // Fees are paid in MON: Cult's gas wallet tops up a wallet that has none.
    if (!demo) await ensureGas(await token()).catch(() => undefined);
    let result;
    try { result = await sendTransaction({ to: action.to, data: action.data, value: BigInt(action.value ?? '0x0') }, { address: wallet.address }); }
    catch (reason) {
      if (/insufficient (balance|funds)/i.test(errorText(reason))) throw new Error('Top up MON for gas.');
      throw reason;
    }
    const chain = config.chainId === monad.id ? monad : monadTestnet;
    const receipt = await createPublicClient({ chain, transport: http() }).waitForTransactionReceipt({ hash: result.hash });
    if (receipt.status !== 'success') throw new Error(`${action.label} failed on-chain.`);
    return result.hash;
  };
  // Wallet actions in order (each waits for its receipt); the last hash.
  const transactAll = async (actions: WalletAction[]) => {
    let hash = '';
    for (const action of actions) { setProgressText(action.label); hash = await transact(action); }
    return hash;
  };
  // Steps only the member's own wallet may sign (opening their Polymarket
  // account, a bet before Cult has a trading key, moving money out): sign each
  // one the backend hands over, give it back, until it's done.
  const signRequest = async (request: SignatureRequest) => {
    if (!wallet) throw new Error('Connect your wallet first.');
    if (request.kind === 'typedData' && request.typedData) {
      // Privy adds the domain type itself.
      const types = Object.fromEntries(Object.entries(request.typedData.types).filter(([name]) => name !== 'EIP712Domain'));
      // Steps that move no money (sign-in, Polymarket approvals, a bet just
      // placed) sign without a pop-up; the rest ask (lib/quietSign).
      const uiOptions = signsQuietly(request) ? { showWalletUIs: false } : { title: request.label };
      const result = await signTypedData({ domain: request.typedData.domain, types, primaryType: request.typedData.primaryType, message: request.typedData.message } as Parameters<typeof signTypedData>[0], { address: wallet.address, uiOptions });
      return result.signature;
    }
    const provider = await wallet.getEthereumProvider();
    const signature = await provider.request({ method: 'personal_sign', params: [request.message, wallet.address] });
    if (typeof signature !== 'string') throw new Error('Wallet did not return a signature.');
    return signature;
  };
  const runFlow = async <T,>(first: T | FlowStep<T>): Promise<T> => {
    let step: T | FlowStep<T> = first;
    for (let round = 0; round < 60 && isFlowStep(step); round++) {
      if (step.status === 'done') return step.result;
      if (step.status === 'working') {
        setProgressText(step.label);
        step = await pollFlow(await token(), step.flowId) as FlowStep<T>;
        continue;
      }
      setProgressText(step.signature.label);
      const signature = await signRequest(step.signature);
      step = await signFlowStep(await token(), step.flowId, step.signature.challengeId, signature) as FlowStep<T>;
    }
    if (isFlowStep(step)) throw new Error('This is taking longer than expected. Check again in a moment.');
    return step;
  };
  const loadPredictionAccount = async () => getPredictionAccount(await token());
  // Open the member's Polymarket account if it isn't yet (signed by their Privy wallet, no pop-ups).
  const readyForPredictions = async () => {
    let account = await loadPredictionAccount();
    if (account.step === 'unavailable') throw new Error(account.reason ?? PREDICTIONS_UNAVAILABLE);
    if (account.step === 'needs_setup') {
      setProgressText('Setting up predictions');
      const opened = await runFlow(await setupPredictions(await token()));
      account = { ...opened, access: account.access };
    }
    return account;
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
    setSnapshot(null);
    setSelectedId(null);
    navigate({ view: 'chat', room: `cult:${joined.id}` });
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
    navigate({ view: 'home' }, true);
    setNotice('You left the cult. Open mirrors will still unwind when their leader exits.');
  });
  // Turning Auto-follow on and changing its limits are the same signed policy.
  const enableAutoFollow = async (policy: MirrorPolicy) => {
    if (!clanId) throw new Error('Choose a cult first.');
    validateMirrorPolicy(policy);
    setBusy('auto-follow'); setError(null);
    try {
      const auth = await token();
      const challenge = await getPolicyChallenge(auth, clanId, policy);
      const signature = await sign(challenge.message);
      await updateClanPolicy(auth, clanId, challenge.challengeId, signature);
      const current = await loadMe();
      const limitsNotice = `Auto-follow is on: up to ${dollars(policy.maxUsdPerTrade)} in copy value, capped at ${policy.balancePercentCap}% of free balance.`;
      if (current.signer.attached !== true || current.signer.policyCurrent !== true) {
        const confirmed = await grantSigner();
        setNotice(`${limitsNotice} ${confirmed ? 'Your wallet signer is ready.' : 'Signer approval is awaiting Privy verification.'}`);
      } else setNotice(limitsNotice);
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
  const enroll = () => { let ready = false; return perform('enroll-perpl', async () => {
    if (!wallet || !config) throw new Error('Connect your trading wallet first.');
    const auth = await token();
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await getPerplSetup(auth);
      setSetup(current);
      if (current.step === 'ready') { await loadMe(); ready = true; setPerpsPrompt(false); setNotice(afterPerps.current ? 'Perps are enabled. Placing your trade…' : 'Perps are enabled for your trades and new copies.'); return; }
      if (current.step === 'needs_collateral') throw new Error(collateralMessage(current.minAccountOpen, config.chainId));
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
  }).then(() => {
    // Setup done: place the trade that was waiting for it.
    const next = afterPerps.current;
    afterPerps.current = null;
    if (ready && next) next();
  }); };
  // A trade that found perps not set up yet: it's placed as soon as setup
  // finishes, so a first-time member doesn't have to tap it again.
  const afterPerps = useRef<(() => void) | null>(null);
  const ensurePerps = async (then?: () => void) => {
    const current = await getPerplSetup(await token());
    setSetup(current);
    if (current.step === 'ready') return true;
    afterPerps.current = then ?? null;
    setPerpsPrompt(true);
    return false;
  };
  const closePerpsPrompt = () => { afterPerps.current = null; setPerpsPrompt(false); };
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
    const dollarsUsable = config?.chainId === 143 || demo ? (balances?.walletUsd ?? 0) + (balances?.usdcUsd ?? 0) : 0;
    const monUsable = Math.max(0, mon - gasReserveMon) * monPrice;
    if (Math.max(dollarsUsable, monUsable) < amountUsd) throw new Error(`Not enough funds for this buy (about ${dollars(Math.max(dollarsUsable, monUsable))} available, keeping ${gasReserveMon} MON for fees).`);
  };
  // A trade from a ticket: funds, gas and the one-time perps setup are checked
  // first. cultIds is "Post to": the cults that see it on their chart and copy
  // it (omitted = all, [] = just you).
  const placeMarketTrade = (target: TicketMarket, side: 'long' | 'short' | 'buy', marginUsd: number, leverage: number | undefined, cultIds: string[] | undefined, tpsl?: TpslValues) => perform('open', async () => {
    if (!signerReady && !await grantSigner()) return;
    if (target.venue === 'nadfun') requireNadFunds(marginUsd);
    if (target.venue === 'perpl' && !await ensurePerps(() => placeMarketTrade(target, side, marginUsd, leverage, cultIds, tpsl))) return;
    setProgressText(target.venue === 'perpl' ? 'Moving funds into your trading account…' : 'Placing your trade…');
    await openPosition(await token(), target.id, target.venue === 'nadfun' ? 'buy' : side, marginUsd, leverage, cultIds);
    let levelsFailed: string | null = null;
    if (target.venue === 'perpl' && tpsl && (tpsl.takeProfit != null || tpsl.stopLoss != null)) {
      setProgressText('Setting take profit and stop loss…');
      await setPositionTpsl(await token(), target.id, tpsl).catch(reason => { levelsFailed = errorText(reason); });
    }
    setProgressText('Refreshing your positions…');
    if (clanId) await loadChart(clanId, target.id).catch(() => undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice(`Trade placed on ${target.symbol}. ${tradeAudienceNotice(me?.clans ?? [], cultIds)}`);
    if (levelsFailed) setError(`The trade is open, but TP/SL wasn't set: ${levelsFailed} Set it from the chart.`);
  });
  const trader = () => ({ name: me?.name ?? 'You', avatarUrl: me?.avatarUrl ?? null });
  const holdingFor = (market: string) => holdings.find(item => item.market.toLowerCase() === market.toLowerCase());
  // An open position's PnL card, from Account (no chart marker needed).
  const shareHolding = (holding: Holding) => setCardSheet({ mode: 'live', result: { ...resultOfClose(holding, null, trader()), live: true } });
  // Share one of your open positions: its PnL card as an image, made right
  // here (no sign-in needed, works in the demo). Real accounts can also share
  // a public link to it.
  const shareMarker = (marker: ChartMarker) => {
    const holding = holdingFor(marker.marketId);
    const symbol = holding?.symbol ?? (snapshot?.selectedMarket.id === marker.marketId ? snapshot.selectedMarket.symbol : marker.marketId);
    const result = holding ? { ...resultOfClose(holding, null, trader()), live: true } : resultOfMarker(marker, symbol, trader());
    setCardSheet({ mode: 'live', result, onShareLink: demo ? undefined : () => void shareLink(marker) });
  };
  // The public link: the phone's share sheet where there is one, otherwise
  // the link is copied and the card opens.
  const shareLink = (marker: ChartMarker) => perform('share', async () => {
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
  // After a close, the PnL card, built from the position as it was just before.
  const showCard = (holding: Holding | undefined, fill: Fill | null) => {
    if (holding) setCardSheet({ mode: 'closed', result: resultOfClose(holding, fill, trader()) });
    else { setCardSheet(null); setNotice('Position close submitted.'); }
  };
  const runClose = (holding: Holding | undefined, market: string, chartMarket: string | undefined, share = 1) => perform('close', async () => {
    try {
      const part = holding && share < 1 ? (BigInt(holding.sizeRaw) * BigInt(Math.round(share * 100)) / BigInt(100)).toString() : undefined;
      const fill = await closePosition(await token(), market, part && part !== '0' ? part : undefined);
      setSelectedId(null);
      if (clanId) await loadChart(clanId, chartMarket).catch(() => undefined);
      setHoldings((await getHoldings(await token())).positions);
      await loadMe();
      showCard(holding && share < 1 ? scaleHolding(holding, share) : holding, fill);
    } catch (reason) { setCardSheet(null); throw reason; }
  });
  // Closing asks first: the PnL card you'd get at the current mark, with
  // Keep open / Close. Confirming closes it and the sheet turns into the
  // final card.
  const askClose = (holding: Holding | undefined, market: string, chartMarket: string | undefined) => {
    const marker = holding ? null : snapshot?.markers.find(m => m.isMine && m.marketId.toLowerCase() === market.toLowerCase());
    const symbol = snapshot?.selectedMarket.id.toLowerCase() === market.toLowerCase() ? snapshot.selectedMarket.symbol : market;
    const preview = holding ? resultOfClose(holding, null, trader()) : marker ? { ...resultOfMarker(marker, symbol, trader()), live: false } : null;
    if (!preview) { void runClose(holding, market, chartMarket); return; }
    const venue = holding?.venue ?? marker?.venue;
    setCloseShare(1);
    setCardSheet({ mode: 'confirm', result: preview, confirmLabel: venue === 'nadfun' ? 'Sell all' : 'Close position', onConfirm: share => void runClose(holding, market, chartMarket, share), closeHolding: holding && holding.sizeRaw !== '0' ? holding : undefined });
  };
  const closeMarket = (marketToClose: string) => askClose(holdingFor(marketToClose), marketToClose, marketToClose);
  // Move dollars from the wallet into the predictions account and wait until
  // the bet can be covered (target), up to ~3 minutes.
  const topUpPredictions = async (shortUsd: number, targetUsd: number, funding: PredictionAccount['funding']) => {
    if (!funding) throw new Error('Bets draw on your balance once Cult runs on Monad mainnet.');
    const move = Math.max(funding.minUsd, Math.ceil(shortUsd * 100) / 100);
    const walletUsd = me?.balances?.walletUsd ?? 0;
    if (walletUsd < move * 1.01) throw new Error(`Not enough dollars for this bet: ${dollars(walletUsd)} in your wallet.`);
    const plan = await fundPredictions(await token(), move);
    await transactAll(plan.actions);
    for (let i = 0; i < 36; i++) {
      setProgressText(`Moving ${dollars(move)} to predictions${i ? `, ${i * 5}s` : ''}…`);
      await new Promise(resolve => window.setTimeout(resolve, 5000));
      const next = await loadPredictionAccount().catch(() => null);
      if ((next?.balanceUsd ?? 0) + 1e-6 >= targetUsd) return;
    }
    throw new Error('Your dollars are still on their way to predictions. Place the bet again in a minute.');
  };
  // Predictions money back to the wallet (from the Withdraw sheet).
  const bringBackPredictions = async (amountUsd: number) => {
    await runFlow(await withdrawPredictions(await token(), amountUsd));
    void loadMe().catch(() => undefined);
  };
  const placePrediction = (order: PredictionOrder) => perform('predict', async () => {
    if (!demo) {
      const account = await readyForPredictions();
      if (account.access?.predictions && account.access.predictions !== 'open') throw new Error('Polymarket doesn’t take new bets from your location.');
      // One balance: if the predictions account is short, the difference moves
      // over from the wallet first (fee on top, ~30s), then the bet goes in.
      const have = account.balanceUsd ?? 0;
      if (have + 1e-6 < order.amountUsd) await topUpPredictions(order.amountUsd - have, order.amountUsd, account.funding);
    }
    await runFlow(await buyPrediction(await token(), order));
    if (!demo) void loadPredictionAccount().catch(() => undefined);
    await loadMe();
    setPredictionRev(value => value + 1);
    const posted = tradeAudienceNotice(me?.clans ?? [], order.cultIds);
    setNotice(`Bet placed: ${order.sideLabel} at ${Math.round(order.price * 100)}¢. ${posted}`);
  });
  // Selling a prediction asks first, with the card as it would close.
  const runSellPrediction = (position: PredictionPosition, price: number) => perform('predict-sell', async () => {
    const sale = await runFlow(await sellPrediction(await token(), position.id, price));
    if (!demo) void loadPredictionAccount().catch(() => undefined);
    await loadMe();
    setPredictionRev(value => value + 1);
    setCardSheet({ mode: 'closed', result: resultOfSale(sale, trader()) });
  });
  const redeemPredictionPosition = (position: PredictionPosition) => perform('predict-redeem', async () => {
    const done = await runFlow(await redeemPrediction(await token(), position.id));
    void loadPredictionAccount().catch(() => undefined);
    setPredictionRev(value => value + 1);
    setNotice(done.payoutUsd > 0 ? `Collected ${dollars(done.payoutUsd)} into predictions.` : 'Settled. This one didn’t pay out.');
  });
  const sellPredictionPosition = (position: PredictionPosition, price: number) =>
    setCardSheet({ mode: 'confirm', result: resultOfPrediction(position, price, trader()), confirmLabel: `Sell for ${dollars(position.shares * price)}`, onConfirm: () => void runSellPrediction(position, price) });
  // A bet you keep, as a card to share.
  const sharePrediction = (position: PredictionPosition, price: number) =>
    setCardSheet({ mode: 'live', result: resultOfPrediction(position, price, trader(), true) });
  const closeTrade = (holding: Holding) => askClose(holding, holding.market, marketId ?? undefined);
  const stack = () => perform('stack', async () => {
    if (!clanId || !selected) throw new Error('Select a cult position first.');
    if (selected.isMine) throw new Error('Choose a cult-mate position to stack.');
    const amount = Number(stackUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.');
    if (!signerReady && !await grantSigner()) return;
    if (selected.venue === 'nadfun') requireNadFunds(amount);
    if (selected.venue === 'perpl' && !await ensurePerps(() => stack())) return;
    const result = await stackPosition(await token(), clanId, selected.id, amount);
    if (result.status !== 'open') throw new Error(result.error ?? 'The stack could not be opened.');
    await loadChart(clanId, marketId ?? undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice('Stacked: the same position is open in your own account.');
  });
  // Copy a cult admin's trade from the chat (Auto-follow off): the same
  // position in your own account, with your amount.
  const copyTrade = (cultId: string, markerId: string, symbol: string, usd: number) => perform('stack', async () => {
    if (!signerReady && !await grantSigner()) return;
    const venue = symbol.startsWith('$') ? 'nadfun' : 'perpl';
    if (venue === 'nadfun') requireNadFunds(usd);
    if (venue === 'perpl' && !await ensurePerps(() => copyTrade(cultId, markerId, symbol, usd))) return;
    const result = await stackPosition(await token(), cultId, markerId, usd);
    if (result.status !== 'open') throw new Error(result.error ?? 'The copy could not be opened.');
    if (clanId === cultId) await loadChart(cultId, marketId ?? undefined).catch(() => undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice(`Copied ${symbol} with ${dollars(usd)}, in your own account.`);
  });
  // An admin makes a member an admin, or takes it back.
  const setAdmin = async (cultId: string, memberId: string, admin: boolean) => {
    try {
      await setCultAdmin(await token(), cultId, memberId, admin);
      await loadChart(cultId, marketId ?? undefined).catch(() => undefined);
      setNotice(admin ? 'They’re an admin now: their trades are shared here.' : 'Admin removed.');
    } catch (reason) { setError(errorText(reason)); }
  };
  const selectMarker = (marker: ChartMarker) => {
    setSelectedId(marker.id);
    setTpDraft(levelDraft(marker.takeProfitPrice));
    setSlDraft(levelDraft(marker.stopLossPrice));
  };
  const showOnMarketPage = (marker: ChartMarker) => {
    setMarketSolo(false);
    navigate({ view: 'markets', market: marker.marketId });
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
      if (kind === 'takeProfit') setTpDraft(levelDraft(level)); else setSlDraft(levelDraft(level));
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
    setTpDraft(levelDraft(suggestion.takeProfitPrice));
    setSlDraft(levelDraft(suggestion.stopLossPrice));
    await loadChart(clanId, marketId ?? undefined);
    setNotice('Suggestion applied to your trigger orders.');
  });
  const openRoom = (id: string) => navigate({ view: 'chat', room: id });
  // A cult room's page picks that cult for the chart and live updates (also
  // when it's reached with back/forward or opened from a link).
  const routeCult = view === 'chat' && roomId.startsWith('cult:') ? roomId.slice(5) : null;
  const joinedRouteCult = routeCult && me?.clans.some(item => item.id === routeCult) ? routeCult : null;
  useEffect(() => {
    if (!joinedRouteCult) return;
    setClanId(joinedRouteCult);
    setSnapshot(current => current && current.clan.id !== joinedRouteCult ? null : current);
  }, [joinedRouteCult]);
  const openAccount = (id = 'me', tab: AccountTab = 'open') => navigate({ view: 'account', profile: id, tab });
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
    void disablePhonePush().catch(() => undefined).then(() => logout()).then(() => navigate({ view: 'home' }, true));
  };

  // The market page asks the cult chart for its own market (once per page).
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${clanId}:${marketPage}`;
    if (view !== 'markets' || !marketPage || marketPage.startsWith('pm:') || marketSolo || !clanId || askedFor.current === key) return;
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
  // Where the top search looks: on a market screen, that market's kind comes
  // first (perps, memes or predictions), then the others; on the cult screens
  // it finds only your cults; on Discover it filters the page's list of every
  // public cult (no dropdown); anywhere else, everything.
  const marketSection = marketPage?.startsWith('pm:') ? 'predictions' as const
    : marketPage ? (cachedList('')?.find(m => m.id === marketPage)?.venue ?? marketsTab)
    : marketsTab;
  const searchScope = view === 'groups' || view === 'chat' ? 'cults' : view === 'discover' ? 'discover' : view === 'markets' ? marketSection : 'all';
  const searchRooms = useMemo(() => me?.rooms.filter(room => (searchScope !== 'cults' || room.kind === 'cult') && room.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 5) ?? [], [me, search, searchScope]);
  type SearchKind = 'perpl' | 'nadfun' | 'predictions' | 'rooms';
  const searchOrder: SearchKind[] = searchScope === 'discover' ? [] : searchScope === 'cults' ? ['rooms']
    : searchScope === 'all' ? ['perpl', 'nadfun', 'predictions', 'rooms']
    : [searchScope, ...(['perpl', 'nadfun', 'predictions'] as const).filter(kind => kind !== searchScope)];
  const searchPlaceholder = searchScope === 'discover' ? 'Search all cults' : searchScope === 'cults' ? 'Search your cults' : searchScope === 'perpl' ? 'Search perps' : searchScope === 'nadfun' ? 'Search memes' : searchScope === 'predictions' ? 'Search predictions' : 'Search markets, memes, cults';

  // While sign-in loads, the splash, never a flash of the landing page: on
  // app pages (anything but /), for the demo, and for a signed-in browser.
  const splash = <div className="dash-splash" aria-busy="true"><img src="/landing/cult-logo.svg" alt="Cult" width={58} height={30} /></div>;
  const expectApp = demoHint || expectSession || pathname !== '/';
  if ((demo === null || !ready) && expectApp) return splash;
  if (demo === null || !ready || !authenticated) return <Landing onLogin={requestLogin} pendingLogin={pendingLogin} onDemo={demoEnabled() ? () => { enterDemo(); setDemo(true); } : undefined} />;
  if (me?.needsUsername) return <UsernameGate onSave={async username => { await setUsername(await token(), username); await loadMe(); }} />;
  // Then a PIN: new members, members from before PINs, and after "Forgot PIN".
  const cancelPinReset = () => { try { window.sessionStorage.removeItem(PIN_RESET_KEY); } catch { /* fine */ } setPinReset(false); };
  if (me && !demo && (me.pinSet === false || (pinReset && me.pinSet))) return <PinGate mode={me.pinSet ? 'reset' : 'set'} onSignOut={signOut} onCancel={me.pinSet ? cancelPinReset : undefined} onSave={async pin => {
    if (me.pinSet) await resetPin(await token(), pin); else await setPin(await token(), pin);
    cancelPinReset();
    await loadMe();
    if (me.pinSet) setNotice('Your new PIN is set.');
  }} />;

  const pickSearch = (action: () => void) => { action(); setSearch(''); setSearchOpen(false); searchRef.current?.blur(); };
  // The search results, grouped and in the order above.
  const marketRow = (item: MarketListing) => <><TokenLogo symbol={item.symbol} imageUri={item.imageUri} /><span className="search-name"><strong>{item.symbol}</strong><small>{item.venue === 'perpl' ? `Perp · up to ${Math.floor(item.maxLeverage)}x` : item.name}</small></span>
    <span className="search-price"><strong className="num">{price(item.priceUsd)}</strong><Change pct={item.change24hPct} /></span></>;
  const searchResults = searchOrder.map(kind => kind === 'rooms'
    ? { kind, label: searchScope === 'cults' ? 'Your cults' : 'Cults & rooms', items: searchRooms.map(room => ({ key: room.id, open: () => openRoom(room.id), row: <><RoomBadge icon={room.icon} kind={room.kind} size="sm" /><span className="search-name"><strong>{room.name}</strong><small>{room.memberCount} members</small></span></> })) }
    : kind === 'predictions'
      ? { kind, label: 'Predictions', items: searchPredictions.map(event => ({ key: event.slug, open: () => openPrediction(event.slug), row: <><EventArt event={event} /><span className="search-name"><strong className="search-title">{event.title}</strong><small>{event.multi ? `${event.outcomes[0]?.label ?? ''} ${chance(event.outcomes[0]?.yesPrice ?? 0)}` : `${chance(event.outcomes[0]?.yesPrice ?? 0)} chance`}</small></span></> })) }
      : { kind, label: kind === 'perpl' ? 'Perps' : 'Memes', items: searchMarkets.filter(item => item.venue === kind).slice(0, 5).map(item => ({ key: `${item.venue}:${item.id}`, open: () => openMarket(item.id), row: marketRow(item) })) });
  const balance = me?.balances ? me.balances.walletUsd + (me.balances.usdcUsd ?? 0) + (me.balances.perplMarginUsd ?? 0) + (me.balances.predictionsUsd ?? 0) : null;
// Main menu, most used first.
  const nav: NavItem[] = [
    { id: 'home', label: 'Home', icon: <Home size={18} />, active: view === 'home', onClick: () => go('home') },
    { id: 'markets', label: 'Markets', icon: <CandlestickChart size={18} />, active: view === 'markets', onClick: () => openMarket(null) },
    { id: 'discover', label: 'Discover', icon: <Compass size={18} />, active: view === 'discover', onClick: () => go('discover') },
    { id: 'leaderboards', label: 'Leaderboard', icon: <Trophy size={18} />, active: view === 'leaderboards', onClick: () => go('leaderboards') },
  ];

  return <div className="dash">
    <header className="topbar" ref={topbarRef}>
      <button className="topbar-logo" onClick={() => go('home')} aria-label="Cult home"><img src="/landing/cult-logo.svg" alt="Cult" width={58} height={30} /></button>
      <div className="search">
        <label className="search-box"><Search size={16} /><input ref={searchRef} value={search} onChange={event => { setSearch(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onBlur={() => window.setTimeout(() => setSearchOpen(false), 160)}
          onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); event.currentTarget.blur(); } if (event.key === 'Enter') { const first = searchResults.find(group => group.items.length)?.items[0]; if (first) pickSearch(first.open); } }}
          placeholder={searchPlaceholder} aria-label={searchPlaceholder} /><kbd>/</kbd>
          {search && <button type="button" className="search-clear" aria-label="Clear search" onMouseDown={event => event.preventDefault()} onClick={() => { setSearch(''); setSearchOpen(false); searchRef.current?.blur(); }}><X size={16} /></button>}</label>
        {searchOpen && search.trim() && searchScope !== 'discover' && <div className="search-drop" role="listbox">
          {searchResults.map(group => group.items.length > 0 && <Fragment key={group.kind}><span className="search-label">{group.label}</span>{group.items.map(item => <button key={item.key} role="option" aria-selected={false} onMouseDown={event => event.preventDefault()} onClick={() => pickSearch(item.open)}>{item.row}</button>)}</Fragment>)}
          {!searchResults.some(group => group.items.length) && <p className="search-empty">{searchScope === 'cults' ? 'None of your cults match' : 'Nothing matches'} &ldquo;{search.trim()}&rdquo;{searchScope === 'cults' ? '.' : ' yet.'}</p>}
        </div>}
      </div>
      <div className="topbar-right">
        {me && <AlertsMenu owner={me.id} onMarket={openMarket} onRoom={openRoom} />}
        {demo && <span className="demo-pill" title="Sample data. Nothing here touches real funds.">Demo</span>}
        <div className="wallet-pill" title="Wallet and trading account">
          <span className="num">{balance == null ? '—' : dollars(balance)}</span>
          <button className="wallet-add" onClick={() => setDepositOpen(true)} aria-label="Deposit" title="Deposit"><Plus size={16} strokeWidth={2.2} /></button>
        </div>
        <button className="topbar-me" onClick={() => openAccount()} title="Account"><Avatar name={me?.name ?? 'You'} url={me?.avatarUrl} /><span className="topbar-me-lines"><strong>{me?.name ?? 'You'}</strong><small className="num">{me ? shortAddress(me.address) : ''}</small></span></button>
      </div>
    </header>

    <SideRail me={me} nav={nav} activeRoom={view === 'chat' ? roomId : null} unread={unread} mentioned={mentioned}
      onRoom={openRoom} onCreate={() => setFormOpen('create')}
      settingsActive={view === 'account' && profileId === 'me' && accountTab === 'settings'} onSettings={() => openAccount('me', 'settings')} onSignOut={signOut} />

    <main className="stage" key={view === 'chat' ? `chat:${roomId}` : view === 'markets' ? `m:${marketPage ?? ''}` : view === 'account' ? `a:${profileId}` : view}>
      {!me ? <div className="view two-col"><section className="view-main"><div className="skel skel-head" /><div className="skel skel-strip" /><div className="skel skel-chart" /></section><aside className="view-side"><div className="skel skel-card" /><div className="skel skel-card" /></aside></div>
        : view === 'home' ? <HomeView me={me} holdings={holdings} unread={unread} mentioned={mentioned} search={search} onMarket={openMarket} onRoom={openRoom} onProfile={openAccount} onTrade={trade => setTradeSheetTarget(trade.tradeId ? { kind: 'trade', tradeId: trade.tradeId } : { kind: 'home', trade })} onDeposit={() => setDepositOpen(true)} onCreate={() => setFormOpen('create')} onDiscover={() => go('discover')} />
        : view === 'markets' ? (marketPage?.startsWith('pm:') ? <PredictionPage slug={marketPage.slice(3)} pick={predictionPick} me={me} canTrade={!!demo || !!config?.features?.predictions} busy={busy} revision={predictionRev} cults={me.clans.map(c => ({ id: c.id, name: c.name }))} onAccountNeeded={demo ? undefined : () => { void loadPredictionAccount().catch(() => undefined); }}
            onBack={() => goUp({ view: 'markets' })} onBuy={placePrediction} onSell={sellPredictionPosition} onShare={sharePrediction} onDeposit={() => setDepositOpen(true)} onProfile={openAccount} />
          : marketPage ? <MarketPage id={marketPage} me={me} config={config} busy={busy} social={marketSocial} holdings={holdings} onBack={() => goUp({ view: 'markets' })} onTrade={placeMarketTrade} onDeposit={() => setDepositOpen(true)} /> : <MarketsView owner={me.id} onSection={setMarketsTab} search={search} onOpen={openMarket} onPredict={openPrediction} predictionRevision={predictionRev} />)
        : view === 'groups' ? <div className="view one-col"><section className="view-main"><header className="page-head"><div><h1 className="display">Cults</h1></div><div className="page-actions"><button className="btn btn-ghost btn-sm" onClick={() => setFormOpen('join')}><Link2 size={15} /> Invite code</button><button className="btn btn-primary btn-sm" onClick={() => setFormOpen('create')}><Plus size={15} /> Create</button></div></header><div className="card flush">{[...latestFirst(me.rooms.filter(room => room.kind === 'cult')), ...me.rooms.filter(room => room.kind !== 'cult')].filter(room => room.name.toLowerCase().includes(search.trim().toLowerCase())).map(room => <RoomRow key={room.id} room={room} unread={unread[room.id]} mention={mentioned[room.id]} onOpen={() => openRoom(room.id)} />)}</div></section></div>
        : view === 'discover' ? <DiscoverCults busy={!!busy} onJoin={joinPublic} country={me.country ?? null} cultId={clanId} onProfile={openAccount} search={search} onCreate={() => setFormOpen('create')} onInvite={() => setFormOpen('join')} onOpenRoom={openRoom} />
        : view === 'leaderboards' ? <Leaderboards country={me.country ?? null} cultId={clanId} onProfile={openAccount} />
        : view === 'account' ? <AccountView id={profileId} holdings={holdings} onCloseHolding={closeTrade} onShareHolding={shareHolding} onMarket={openMarket} onDeposit={() => setDepositOpen(true)} onWithdraw={() => setWithdrawOpen(true)} onSignOut={signOut} tab={accountTab} onTab={tab => navigate({ view: 'account', profile: profileId, tab }, true)} predictionRevision={predictionRev} onOpenPrediction={openPrediction} onSellPrediction={sellPredictionPosition} onRedeemPrediction={demo ? undefined : redeemPredictionPosition} signOutLabel={demo ? 'Exit demo' : 'Sign out'} onTrade={setTradeSheetTarget} onAvatarSaved={loadMe} onRoom={openRoom} />
        : <div className="view two-col room-view">
          <section className="view-main room-main">
            <div className="room-mobile"><button className="icon-btn" title="Back to cults" onClick={() => goUp({ view: 'groups' })}><ArrowLeft size={18} /></button><span>{activeRoom && <RoomBadge icon={activeRoom.icon} kind={activeRoom.kind} size="sm" />}{activeRoom?.name ?? 'Room'}</span><button className="btn btn-ghost btn-sm" onClick={() => setGroupPanelOpen(true)}><PanelRightOpen size={14} /> {activeRoom?.kind === 'cult' ? 'Positions' : 'Rankings'}</button></div>
            {activeRoom ? <ClanChat key={activeRoom.id} room={activeRoom} liveMessage={activeRoom.kind === 'cult' ? liveMessage : null} selectedMarker={activeRoom.kind === 'cult' ? selected : null} onOpenMarker={openLinkedMarker} onMember={openAccount} onActivity={loadMeSoon} onInvite={activeRoom.kind === 'cult' ? copyInvite : undefined} canPin={!!clan?.isOwner && activeRoom.kind === 'cult'} meId={me.id} meName={me.name} markers={activeRoom.kind === 'cult' ? snapshot?.markers : undefined}
              onTrade={activeRoom.kind === 'cult' ? () => { setMarketSolo(false); showMarketsTab('perpl'); openMarket(null); } : undefined}
              shareCults={activeRoom.kind === 'cult' ? undefined : me.clans.filter(c => c.visibility === 'public').map(c => ({ id: c.id, name: c.name }))}
              myCultIds={me.clans.map(c => c.id)} onJoinCult={joinPublic} onOpenRoom={openRoom}
              copyable={activeRoom.kind === 'cult' && !(clan?.autoFollow ?? false)} copyUsd={Number(stackUsd) || 50}
              onCopyTrade={activeRoom.kind === 'cult' ? (markerId, symbol, usd) => copyTrade(activeRoom.id.slice(5), markerId, symbol, usd) : undefined} />
              : <div className="empty"><strong>This room is unavailable.</strong><span>Refresh your account or choose a country in Account.</span></div>}
          </section>
          {activeRoom && <div className={`view-side room-side ${groupPanelOpen ? 'open' : ''}`}>
            <button className="sheet-close" onClick={() => setGroupPanelOpen(false)}><X size={16} /> Close</button>
            <GroupPanel key={activeRoom.id} room={activeRoom} cult={activeRoom.kind === 'cult' ? clan ?? null : null} config={config} snapshot={activeRoom.kind === 'cult' ? snapshot : null} selected={activeRoom.kind === 'cult' ? selected : null} busy={!!busy} signerPrompt={signerPrompt}
              perpsReady={perpsCopyReady(me.perpl)} perpsFunded={(availableTradeFunds('perpl', me.balances, config?.monPriceAusd ?? null, config?.chainId) ?? 1) > 0}
              copyFailure={copyFailure && copyFailure.clanId === clan?.id ? copyFailure.reason : null} onDismissCopyFailure={() => setCopyFailure(null)}
              onEnablePerps={() => { void perform('prepare-perps', async () => { if (await ensurePerps()) { await loadMe(); setNotice('Perp copying is authorized.'); } }); }} onDeposit={() => setDepositOpen(true)}
              onGrantSigner={() => { void perform('grant-signer', async () => { const confirmed = await grantSigner(); setNotice(confirmed ? 'Trading signer is active.' : 'Signer approval is awaiting Privy verification.'); }); }}
              onFollowOn={enableAutoFollow} onFollowOff={disableAutoFollow} onMarket={id => { setMarketId(id); setSelectedId(null); }} onMarker={selectMarker}
              onOpenTrade={() => { if (market) { setMarketSolo(false); navigate({ view: 'markets', market: market.id }); } }} onGuideDrop={(marker, kind, level) => { void submitGuide(marker, kind, level); }}
              onInvite={copyInvite} onVisibility={changeVisibility} onLeave={leave} onProfile={openAccount}
              meId={me.id} onSetAdmin={activeRoom.kind === 'cult' ? (memberId, admin) => setAdmin(activeRoom.id.slice(5), memberId, admin) : undefined} />
          </div>}
          {groupPanelOpen && <button className="sheet-scrim" aria-label="Close details" onClick={() => setGroupPanelOpen(false)} />}
        </div>}
    </main>

    <Ticker live={liveConnected} demo={!!demo} onMarket={id => openMarket(id)} onExitDemo={signOut} />

    <nav className="tabbar" aria-label="Mobile navigation">
      <button className={view === 'home' ? 'on' : ''} onClick={() => go('home')}><Home size={20} /><span>Home</span></button>
      <button className={view === 'markets' ? 'on' : ''} onClick={() => openMarket(null)}><CandlestickChart size={20} /><span>Markets</span></button>
      <button className={['groups', 'chat'].includes(view) ? 'on' : ''} onClick={() => go('groups')} aria-label={mentionedAny ? 'Cults, you were mentioned' : unreadTotal ? `Cults, ${unreadTotal} unread` : undefined}><span className="badge-wrap"><UsersRound size={20} /><UnreadBubble count={unreadTotal} mention={mentionedAny} /></span><span>Cults</span></button>
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
    {cardSheet && <PnlCardSheet {...cardSheet} busy={cardSheet.mode === 'confirm' && (busy === 'close' || busy === 'predict-sell')} onClose={() => setCardSheet(null)}
      result={cardSheet.mode === 'confirm' && cardSheet.closeHolding ? resultOfClose(scaleHolding(cardSheet.closeHolding, closeShare), null, trader()) : cardSheet.result}
      confirmLabel={closeShare < 1 && cardSheet.closeHolding ? `${cardSheet.closeHolding.venue === 'nadfun' ? 'Sell' : 'Close'} ${Math.round(closeShare * 100)}%` : cardSheet.confirmLabel}
      onConfirm={cardSheet.onConfirm ? () => cardSheet.onConfirm!(cardSheet.closeHolding ? closeShare : 1) : undefined}
      closeShare={closeShare} onCloseShare={cardSheet.closeHolding ? setCloseShare : undefined} />}
    {withdrawOpen && <WithdrawSheet onClose={() => setWithdrawOpen(false)} onDone={() => { void loadMe(); }} predictionsUsd={demo ? null : me?.balances?.predictionsUsd ?? null} onBringBack={demo ? undefined : bringBackPredictions} gasReserveMon={me?.balances?.gasReserveMon ?? 0} onSend={transactAll} crossChain={!!demo || !!config?.features?.crossChain} />}
    {depositOpen && <DepositSheet crossChain={!!demo || !!config?.features?.crossChain} onClose={() => setDepositOpen(false)} signerReady={signerReady} permissionBusy={!!busy} onGrantPermission={() => { void perform('grant-signer', async () => { if (await grantSigner()) setNotice('Trading permission is active.'); }); }} />}
    {permissionOpen && <TradingPermissionDialog onDecision={decidePermission} />}
    {perpsPrompt && <div className="modal-backdrop"><section className="dialog simple-dialog" role="dialog" aria-modal="true" aria-label="Enable perps"><button className="icon-btn dialog-close" title="Close" disabled={busy === 'enroll-perpl'} onClick={closePerpsPrompt}><X size={16} /></button><h2 className="display">Enable perps</h2><p className="dialog-sub">Your wallet signs the account and trading authorization once. You stay in control of your funds.</p>{progressText && busy === 'enroll-perpl' && <p className="fine" role="status">{progressText}</p>}<button className="btn btn-primary btn-block btn-lg" disabled={!!busy} onClick={enroll}>Enable perps</button>{setup?.step === 'needs_collateral' && <><p className="fine">{collateralMessage(setup.minAccountOpen, config?.chainId)}</p><button className="btn btn-ghost btn-block" onClick={() => { closePerpsPrompt(); setDepositOpen(true); }}>Deposit first</button></>}</section></div>}
    {tradeSheetTarget && <TradeSheet target={tradeSheetTarget} onClose={() => setTradeSheetTarget(null)} onProfile={openAccount} onChart={openTradeChart} />}
    {busy && !permissionOpen && <div className="busy" role="status"><i /><span>{progressText ?? (busy === 'stack' ? 'Authorizing your trade…' : busy === 'open' ? 'Placing your trade…' : 'Working…')}</span></div>}
  </div>;
}
