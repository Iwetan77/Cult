'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { getAccessToken, useCreateWallet, useFundWallet, usePrivy, useSendTransaction, useSignMessage, useSigners, useWallets } from '@privy-io/react-auth';
import { createPublicClient, formatEther, formatUnits, http, isAddress, isHex } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import { ArrowDownToLine, ArrowRight, Copy, ExternalLink, Link2, LogOut, Plus, RefreshCw, ShieldCheck, Wallet, X } from 'lucide-react';
import { createClan, createShare, enrollPerpl, getChart, getPolicyChallenge, updateClanPolicy, leaveClan, getClanEventUrl, getConfig, getEnrollmentChallenge, getHoldings, getNadMarkets, getJoinChallenge, getMe, getPerplSetup, getPrivySigner, joinClan, prepareUsdcFunding, confirmUsdcFunding, openPosition, closePosition, skipAutoMirror, stackPosition, setPositionTpsl, suggestMarkerTpsl } from '@/lib/api';
import type { BackendConfig, ChatMessage, ChartMarker, ChartSnapshot, FundingPlan, Holding, Me, MirrorPolicy, NadMarket, PrivySignerGrant, SetupStatus, TpslSuggestion, TpslValues, Venue, WalletAction } from '@/lib/contracts';
import { dollars, percent, shortAddress, signedDollars, signedMon } from '@/lib/format';
import { SharedChart } from './SharedChart';
import { ClanChat } from './ClanChat';

const testnetAusd = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC';
const defaultPolicy: MirrorPolicy = { enabled: true, balancePercentCap: 10, maxUsdPerTrade: 100 };
const venueName = (venue: Venue) => venue === 'perpl' ? 'Perpl' : 'Nad.fun';
const originName = (origin: ChartMarker['origin']) => origin === 'auto_mirror' ? 'Auto mirrored' : origin === 'manual_stack' ? 'Manual stack' : 'Clan position';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
const validatePolicy = (value: MirrorPolicy) => {
  if (!Number.isFinite(value.balancePercentCap) || value.balancePercentCap <= 0 || value.balancePercentCap > 100 || !Number.isFinite(value.maxUsdPerTrade) || value.maxUsdPerTrade < 1 || value.maxUsdPerTrade > 1_000_000) throw new Error('Enter mirror limits within the allowed range.');
};
const inviteFromInput = (input: string) => {
  try { return new URL(input).searchParams.get('invite') ?? input.trim(); }
  catch { return input.trim(); }
};

export function Dashboard() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { sendTransaction } = useSendTransaction();
  const { addSigners } = useSigners();
  const { fundWallet } = useFundWallet();
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [grant, setGrant] = useState<PrivySignerGrant | null>(null);
  const [monBalance, setMonBalance] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [nadMarkets, setNadMarkets] = useState<NadMarket[]>([]);
  const [tradeSide, setTradeSide] = useState<'long' | 'short'>('long');
  const [tradeAusd, setTradeAusd] = useState('50');
  const [tradeLeverage, setTradeLeverage] = useState('2');
  const [fundMode, setFundMode] = useState<'ausd' | 'usdc'>('ausd');
  const [fundDestination, setFundDestination] = useState<'wallet' | 'perpl'>('wallet');
  const [fundingPlan, setFundingPlan] = useState<FundingPlan | null>(null);
  const [fundingConfirmation, setFundingConfirmation] = useState<{ planId: string; hashes: string[]; actionCount: number; depositToPerpl: boolean } | null>(null);
  const [createPolicy, setCreatePolicy] = useState<MirrorPolicy>(defaultPolicy);
  const wallet = wallets.find(item => item.walletClientType === 'privy');
  const [me, setMe] = useState<Me | null>(null);
  const [clanId, setClanId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChartSnapshot | null>(null);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tpDraft, setTpDraft] = useState('');
  const [slDraft, setSlDraft] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [policy, setPolicy] = useState<MirrorPolicy>(defaultPolicy);
  const [editPolicy, setEditPolicy] = useState<MirrorPolicy | null>(null);
  const [policyDraftClanId, setPolicyDraftClanId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [mirrorRetries, setMirrorRetries] = useState<Record<string, string>>({});
  const [liveMessage, setLiveMessage] = useState<ChatMessage | null>(null);
  const [stackUsd, setStackUsd] = useState('50');
  const [fundUsd, setFundUsd] = useState('100');
  const [shareWithClan, setShareWithClan] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [panel, setPanel] = useState<'positions' | 'members' | 'chat' | 'wallet' | 'clan'>('positions');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const clan = me?.clans.find(item => item.id === clanId) ?? snapshot?.clan;
  const selected = snapshot?.markers.find(item => item.id === selectedId) ?? null;
  const market = snapshot?.selectedMarket;
  const balanceMon = me?.balances?.mon ?? monBalance;
  const gasReserveMon = me?.balances?.gasReserveMon ?? 0.25;
  const lowGas = me?.balances?.lowGas ?? (balanceMon != null && balanceMon < gasReserveMon);
  const signerReady = me?.signer.attached === true && me.signer.policyCurrent === true;
  const signerUnknown = me?.signer.attached == null || me.signer.policyCurrent == null;
  const signerPrompt = !clanId || signerReady ? null : me?.signer.attached === false ? 'Allow Cult to copy trades for you' : me?.signer.policyCurrent === false ? 'Re-approve your new limits' : 'Signer status unavailable. Retry shortly.';
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
    Promise.all([loadMe(), getConfig().then(setConfig), token().then(getPerplSetup).then(setSetup)]).catch(err => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [authenticated, wallet, loadMe]);
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
        if (error instanceof AuthError) throw error;
        return 3000;
      },
    }).catch(() => { if (!controller.signal.aborted) setLiveConnected(false); });
    return () => { controller.abort(); window.clearTimeout(refreshTimer); setLiveConnected(false); };
  }, [authenticated, clanId, marketId, loadChart, loadMe]);
  useEffect(() => {
    if (!authenticated || !clanId) return;
    let active = true;
    token().then(getPrivySigner).then(value => { if (active) setGrant(value); }).catch(err => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [authenticated, clanId]);
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
    setGrant(value);
    await addSigners({ address: wallet.address, signers: [{ signerId: value.signerId, policyIds: value.policyIds }] });
    const current = await loadMe();
    return current.signer.attached === true && current.signer.policyCurrent === true;
  };  const create = () => perform('create', async () => {
    if (!name.trim()) throw new Error('Name your clan first.');
    validatePolicy(createPolicy);
    const result = await createClan(await token(), name.trim(), createPolicy);
    await loadMe(); setClanId(result.id); setPanel('wallet'); const confirmed = await grantSigner(); setNotice(confirmed ? 'Clan created. Your trading signer is active.' : 'Clan created. Signer approval is awaiting Privy verification.');
  });
  const join = () => perform('join', async () => {
    const code = inviteFromInput(inviteCode);
    if (!code) throw new Error('Enter an invite code.');
    validatePolicy(policy);
    const auth = await token();
    const challenge = await getJoinChallenge(auth, code, policy);
    const signature = await sign(challenge.message);
    const joined = await joinClan(auth, challenge.challengeId, signature);
    await loadMe(); setClanId(joined.id); setPanel('wallet'); const confirmed = await grantSigner(); setNotice(confirmed ? 'Joined. Your trading signer is active.' : 'Joined. Signer approval is awaiting Privy verification.');
    window.history.replaceState({}, '', '/');
  });
  const savePolicy = () => perform('policy', async () => {
    if (!clanId || !clan?.myPolicy || !editPolicy) throw new Error('Select a clan policy first.');
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
    if (!clanId || !confirmLeave) throw new Error('Confirm that you want to leave this clan.');
    await leaveClan(await token(), clanId);
    const remaining = await loadMe();
    setClanId(remaining.clans[0]?.id ?? null);
    setPolicyDraftClanId(null);
    setEditPolicy(null);
    setSnapshot(null);
    setSelectedId(null);
    setConfirmLeave(false);
    setPanel('positions');
    setNotice('You left the clan. Open mirrors will still unwind when their leader exits.');
  });
  const buyUsdc = () => perform('buy-usdc', async () => {
    if (!wallet || config?.chainId !== monad.id) throw new Error('Card USDC purchase is only available on Monad mainnet.');
    await fundWallet({ address: wallet.address, options: { chain: monad, asset: 'USDC', amount: fundUsd, defaultFundingMethod: 'card' } });
    setNotice('USDC purchase started. Pay with USDC after it arrives in your wallet.');
  });
  const prepareFunding = () => perform('prepare-fund', async () => {
    if (fundingConfirmation) throw new Error('Confirm your previous funding transactions before preparing another route.');
    if (!/^\d+(\.\d{1,6})?$/.test(fundUsd) || Number(fundUsd) <= 0) throw new Error('Enter a positive USDC amount with up to six decimals.');
    const plan = await prepareUsdcFunding(await token(), fundUsd, fundDestination === 'perpl');
    if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error('Funding route expired. Prepare it again.');
    setFundingPlan(plan);
    setNotice('Review the estimated and guaranteed dollar amount before signing.');
  });
  const confirmFunding = async (confirmation: { planId: string; hashes: string[]; actionCount: number; depositToPerpl: boolean }) => {
    const auth = await token();
    const result = await confirmUsdcFunding(auth, confirmation.planId, confirmation.hashes);
    const verifiedWalletSwap = !confirmation.depositToPerpl && result.steps.length === confirmation.actionCount && result.steps.every(step => step.ok);
    if (!result.done && !verifiedWalletSwap) throw new Error('Funding is not confirmed yet. Check your wallet transactions, then retry confirmation without signing again.');
    setFundingConfirmation(null);
    if (confirmation.depositToPerpl) setSetup(await getPerplSetup(auth));
    await loadMe();
    setNotice('Funding confirmed on-chain.');
  };
  const executeFunding = () => perform('fund', async () => {
    const plan = fundingPlan;
    if (!plan) throw new Error('Prepare a funding route first.');
    if (Date.parse(plan.expiresAt) <= Date.now()) { setFundingPlan(null); throw new Error('Funding route expired. Prepare it again.'); }
    setFundingPlan(null);
    const hashes: string[] = [];
    try {
      for (const action of plan.actions) hashes.push(await transact(action));
    } catch (error) {
      throw new Error(`${errorText(error)} Check your wallet activity before preparing another route.`);
    }
    const confirmation = { planId: plan.id, hashes, actionCount: plan.actions.length, depositToPerpl: plan.depositToPerpl };
    setFundingConfirmation(confirmation);
    await confirmFunding(confirmation);
  });
  const enroll = () => perform('enroll-perpl', async () => {
    if (!wallet || !config) throw new Error('Connect your trading wallet first.');
    const auth = await token();
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await getPerplSetup(auth);
      setSetup(current);
      if (current.step === 'ready') { setNotice('Perpl setup is ready. Your wallet remains yours.'); return; }
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
  });  const skip = () => perform('skip', async () => {
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
    if (market.venue === 'nadfun') { if (!signerReady) throw new Error('Approve the capped backend signer first.'); requireNadFunds(amount); }
    if (market.venue === 'perpl' && setup?.step !== 'ready') throw new Error('Complete Perpl setup before opening a position.');
    const leverage = market.venue === 'perpl' ? Number(tradeLeverage) : undefined;
    if (leverage !== undefined && (!Number.isFinite(leverage) || leverage < 1 || leverage > market.maxLeverage)) throw new Error('Leverage is outside this market\'s limit.');
    await openPosition(await token(), market.id, market.venue === 'nadfun' ? 'buy' : tradeSide, amount, leverage);
    await loadChart(clanId, marketId ?? undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice('Your own trade is open on the clan chart.');
  });
  const closeTrade = (holding: Holding) => perform('close', async () => {
    await closePosition(await token(), holding.market);
    if (clanId) await loadChart(clanId, marketId ?? undefined);
    setHoldings((await getHoldings(await token())).positions);
    await loadMe();
    setNotice('Position close submitted.');
  });  const stack = () => perform('stack', async () => {
    if (!clanId || !selected) throw new Error('Select a clan position first.');
    if (selected.isMine) throw new Error('Choose a clan-mate position to stack.');
    const amount = Number(stackUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.');
    if (selected.venue === 'nadfun') { if (!signerReady) throw new Error('Approve the capped backend signer first.'); requireNadFunds(amount); }
    if (selected.venue === 'perpl' && setup?.step !== 'ready') throw new Error('Complete Perpl setup before stacking.');
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
    if (!clanId || !snapshot) throw new Error('Open a clan chart to view this trade.');
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
    throw new Error('This linked trade is no longer open on the clan chart.');
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
  const copyInvite = async () => {
    if (!clan) return;
    await navigator.clipboard.writeText(`${window.location.origin}/?invite=${encodeURIComponent(clan.inviteCode)}`);
    setNotice('Invite link copied.');
  };

  if (!ready) return <main className="config-state"><div className="brand">CULT<span className="brand-dot">.</span></div><p>Opening wallet…</p></main>;
  if (!authenticated) return <main className="login-screen"><div className="login-brand">CULT<span>.</span></div><div className="login-main"><p className="eyebrow">PRIVATE CLANS / MONAD</p><h1>Trade together.<br />Own every move.</h1><p>One chart for your clan’s live positions across Perpl and Nad.fun. Your wallet, your funds, your trades.</p><button className="primary large" onClick={login}>Enter with your wallet <ArrowRight size={17} /></button></div><div className="login-foot">INVITE ONLY <span>•</span> NO SHARED CUSTODY</div></main>;
  if (!wallet) return <main className="config-state"><div className="brand">CULT<span className="brand-dot">.</span></div><h1>Wallet setup</h1><p>Create your Privy trading wallet to fund and trade from your own account.</p><button className="primary" onClick={() => createWallet().catch(err => setError(errorText(err)))}>Create trading wallet</button></main>;
if (!me && !error) return <main className="config-state"><div className="brand">CULT<span className="brand-dot">.</span></div><p>Loading your clans…</p></main>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand">CULT<span className="brand-dot">.</span></div><div className="topbar-divider" /><span className="topbar-caption">PRIVATE TRADING CLANS</span><div className="topbar-right"><span className="network-pill"><i /> {config?.chainId === 10143 ? 'MONAD TESTNET' : 'MONAD'}</span><button className="wallet-pill" onClick={() => setPanel('wallet')}><Wallet size={15} /> {shortAddress(wallet.address)}</button><button className="icon-button" title="Sign out" onClick={logout}><LogOut size={16} /></button></div></header>
    <div className="workspace"><aside className="rail"><div className="rail-heading">YOUR CLANS <button className="icon-button compact" title="Create or join a clan" onClick={() => setClanId(null)}><Plus size={15} /></button></div><div className="clan-list">{me?.clans.map(item => <button key={item.id} className={`clan-item ${item.id === clanId ? 'active' : ''}`} onClick={() => { setClanId(item.id); setSnapshot(null); setSelectedId(null); }}><span className="clan-avatar">{item.name.slice(0, 1).toUpperCase()}</span><span className="clan-name">{item.name}</span><span className="clan-count">{item.memberCount}</span></button>)}</div><div className="rail-footer"><span className="tiny-label">SIGNED IN AS</span><strong>{me?.name ?? shortAddress(wallet.address)}</strong><span>{shortAddress(wallet.address)}</span></div></aside>
    {!clanId ? <main className="setup-main"><div className="setup-header"><p className="eyebrow">GET STARTED</p><h1>Find your circle.</h1><p>Clans are private. Create one or join with an invite.</p></div><div className="setup-grid"><section className="setup-section"><div className="section-number">01 / CREATE</div><h2>Start a clan</h2><label className="field-label" htmlFor="clan-name">CLAN NAME</label><input id="clan-name" value={name} onChange={event => setName(event.target.value)} maxLength={36} placeholder="Name your circle" /><div className="policy-heading"><ShieldCheck size={17} /><strong>Auto-mirror limits</strong></div><p className="field-note">Creating authorizes your wallet to mirror clan trades within these limits. You fund and hold your own positions. {config && `You can skip each mirror for ${config.autoMirrorOptOutWindowSeconds} seconds.`}</p><label className="switch-row"><span>Auto mirror</span><input type="checkbox" checked={createPolicy.enabled} onChange={event => setCreatePolicy({ ...createPolicy, enabled: event.target.checked })} /></label><div className="policy-fields"><label><span className="field-label">UP TO % OF BALANCE</span><input type="number" min="1" max="100" value={createPolicy.balancePercentCap} disabled={!createPolicy.enabled} onChange={event => setCreatePolicy({ ...createPolicy, balancePercentCap: Number(event.target.value) })} /></label><label><span className="field-label">MAX $ PER TRADE</span><input type="number" min="1" value={createPolicy.maxUsdPerTrade} disabled={!createPolicy.enabled} onChange={event => setCreatePolicy({ ...createPolicy, maxUsdPerTrade: Number(event.target.value) })} /></label></div><button className="primary full" disabled={!!busy} onClick={create}>Create clan <ArrowRight size={16} /></button></section><section className="setup-section"><div className="section-number">02 / JOIN</div><h2>Use an invite</h2><label className="field-label" htmlFor="invite-code">INVITE CODE</label><input id="invite-code" value={inviteCode} onChange={event => setInviteCode(event.target.value)} placeholder="Paste code or link" /><div className="policy-heading"><ShieldCheck size={17} /><strong>Auto-mirror limits</strong></div><p className="field-note">Joining authorizes your wallet to mirror clan trades within these limits. You fund and hold your own positions. {config && `You can skip each mirror for ${config.autoMirrorOptOutWindowSeconds} seconds.`}</p><label className="switch-row"><span>Auto mirror</span><input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({ ...policy, enabled: event.target.checked })} /></label><div className="policy-fields"><label><span className="field-label">UP TO % OF BALANCE</span><input type="number" min="1" max="100" value={policy.balancePercentCap} disabled={!policy.enabled} onChange={event => setPolicy({ ...policy, balancePercentCap: Number(event.target.value) })} /></label><label><span className="field-label">MAX $ PER TRADE</span><input type="number" min="1" value={policy.maxUsdPerTrade} disabled={!policy.enabled} onChange={event => setPolicy({ ...policy, maxUsdPerTrade: Number(event.target.value) })} /></label></div><button className="primary full" disabled={!!busy} onClick={join}>Sign & join clan <ArrowRight size={16} /></button></section></div></main> : <main className="main"><div className="main-head"><div><div className="eyebrow">CLAN / {clan?.memberCount ?? 0} MEMBERS</div><h1>{clan?.name ?? 'Clan'}</h1></div><button className="outline" onClick={copyInvite}><Link2 size={15} /> Invite</button></div>{signerPrompt && <div className="signer-alert"><span><ShieldCheck size={15} /> {signerPrompt}. Nad.fun copies are paused until your signer is attached under the current limits.</span><button className="outline" onClick={() => setPanel('wallet')}>Review wallet</button></div>}<div className="market-head"><div className="market-tabs">{snapshot?.markets.map(item => <button key={`${item.venue}:${item.id}`} className={item.id === market?.id && item.venue === market.venue ? 'active' : ''} onClick={() => { setMarketId(item.id); setSelectedId(null); }}><span>{item.symbol}</span><small>{venueName(item.venue)}</small></button>)}</div><select className="nad-market-picker" aria-label="Nad.fun token" value={market?.venue === 'nadfun' ? market.id : ''} onChange={event => { if (event.target.value) { setMarketId(event.target.value); setSelectedId(null); } }}><option value="">Nad.fun token</option>{nadMarkets.map(item => <option key={item.id} value={item.id}>{item.symbol}</option>)}</select><button className="icon-button" title="Refresh chart" onClick={() => loadChart(clanId, marketId ?? undefined).catch(err => setError(errorText(err)))}><RefreshCw size={16} /></button></div><section className="chart-section"><div className="chart-title"><div><span className="market-symbol">{market?.symbol ?? 'MARKET'}</span><span className="venue-badge">{market ? venueName(market.venue) : 'LIVE'}</span></div><span className="chart-updated">{lastRefresh ? `${liveConnected ? 'LIVE' : 'UPDATED'} ${lastRefresh.toLocaleTimeString()}` : 'CONNECTING'}</span></div><SharedChart candles={snapshot?.candles ?? []} markers={visibleMarkers} market={market ?? { venue: 'perpl', id: '', symbol: '', baseSymbol: '', quoteSymbol: 'USD', maxLeverage: 1, makerFeeBps: null, takerFeeBps: null }} selectedId={selectedId} onSelect={selectMarker} onGuideDrop={(marker, kind, price) => { void submitGuide(marker, kind, price); }} guidesDisabled={!!busy} /><div className="chart-legend"><span><i className="legend-triangle" /> Clan position</span><span><i className="legend-circle" /> Auto mirrored</span><span><i className="legend-square" /> Manual stack</span><span className="chart-legend-right">{visibleMarkers.length} LIVE MARKERS</span></div></section><div className="positions-strip"><div className="strip-heading"><h2>On this chart</h2><span>{visibleMarkers.length} positions</span></div><div className="position-list">{visibleMarkers.length ? visibleMarkers.map(item => <button key={item.id} className={`position-row ${item.id === selectedId ? 'selected' : ''}`} onClick={() => selectMarker(item)}><i className={`origin-icon ${item.origin}`} /><span className="position-person">{item.memberName}{item.isMine && <small>YOU</small>}</span><span className="position-meta">{originName(item.origin)} · {item.side.toUpperCase()}{item.mirrorStatus === 'pending' && mirrorRetries[item.id] ? ' · RETRYING' : ''}{item.pendingAdd ? ` · ADD x${item.pendingAdd.ratio.toFixed(2)}` : ''}</span><strong className={(item.pnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{item.venue === 'perpl' ? item.pnlUsd == null ? 'Pending' : signedDollars(item.pnlUsd) : item.valueUsd == null ? 'Pending' : dollars(item.valueUsd)}</strong></button>) : <p className="empty-line">No open clan positions on this market yet.</p>}</div></div></main>}
    <aside className="detail"><div className="detail-tabs"><button className={panel === 'positions' ? 'active' : ''} onClick={() => setPanel('positions')}>Trade</button><button className={panel === 'members' ? 'active' : ''} onClick={() => setPanel('members')}>Members</button><button className={panel === 'chat' ? 'active' : ''} onClick={() => setPanel('chat')}>Chat</button><button className={panel === 'wallet' ? 'active' : ''} onClick={() => setPanel('wallet')}>Wallet</button><button className={panel === 'clan' ? 'active' : ''} onClick={() => setPanel('clan')}>Clan</button></div>{panel === 'positions' ? <div className="detail-body">{selected ? <><div className="detail-heading"><span className={`origin-tag ${selected.origin}`}>{originName(selected.origin)}</span><button className="icon-button compact" title="Close position details" onClick={() => setSelectedId(null)}><X size={15} /></button></div><h2>{selected.memberName} {selected.side === 'buy' ? 'holds' : selected.side}</h2><p className="detail-sub">{market?.symbol} on {venueName(selected.venue)}</p>{selected.mirrorStatus === 'pending' && mirrorRetries[selected.id] && <p className="wallet-warning">{mirrorRetries[selected.id]}</p>}<div className="stat-pair"><span>ENTRY</span><strong>{selected.entryPrice == null ? 'Pending' : dollars(selected.entryPrice, selected.entryPrice < 1 ? 6 : 2)}</strong></div><div className="stat-pair"><span>CURRENT</span><strong>{dollars(selected.markPrice, selected.markPrice < 1 ? 6 : 2)}</strong></div>{selected.venue === 'perpl' && selected.entryPrice != null && <><div className="stat-pair"><span>TAKE PROFIT</span><strong>{dollars(selected.takeProfitPrice)}</strong></div><div className="stat-pair"><span>STOP LOSS</span><strong>{dollars(selected.stopLossPrice)}</strong></div></>}<div className="pnl-block"><span>{selected.venue === 'perpl' ? 'LIVE PNL' : 'CURRENT VALUE'}</span><strong className={(selected.pnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{selected.venue === 'perpl' ? selected.pnlUsd == null ? 'Pending' : signedDollars(selected.pnlUsd) : selected.valueUsd == null ? 'Pending' : dollars(selected.valueUsd)}</strong></div>{selected.venue === 'perpl' && selected.entryPrice != null && <><div className="trade-divider" /><h3>{selected.isMine ? 'Manage TP / SL' : 'Suggest TP / SL'}</h3><div className="level-fields"><label><span className="field-label">TAKE PROFIT / $</span><input type="number" step="any" value={tpDraft} onChange={event => setTpDraft(event.target.value)} /></label><label><span className="field-label">STOP LOSS / $</span><input type="number" step="any" value={slDraft} onChange={event => setSlDraft(event.target.value)} /></label></div><button className="outline full" disabled={!!busy} onClick={saveLevels}>{selected.isMine ? 'Save trigger orders' : 'Send suggestion'}</button></>}{!selected.isMine ? <><div className="trade-divider" /><h3>Stack this trade</h3><p className="field-note">A new position in your account. This is your choice, separate from automatic mirroring.</p><label className="field-label" htmlFor="stack-size">YOUR SIZE / $</label><input id="stack-size" type="number" min="1" value={stackUsd} onChange={event => setStackUsd(event.target.value)} /><button className="primary full" disabled={!!busy} onClick={stack}>{selected.venue === 'perpl' ? 'Open my position' : 'Buy in my account'} <ArrowRight size={16} /></button></> : <>{selected.origin === 'auto_mirror' && selected.mirrorStatus === 'pending' && selected.skipUntil && Date.parse(selected.skipUntil) > now && <><div className="trade-divider" /><h3>Pending auto mirror</h3><p className="field-note">You can skip this trade for {Math.max(0, Math.ceil((Date.parse(selected.skipUntil) - now) / 1000))} more seconds.</p><button className="outline full" disabled={!!busy} onClick={skip}>Skip this mirror</button></>}{selected.pendingAdd && <><div className="trade-divider" /><h3>Leader is adding (x{selected.pendingAdd.ratio.toFixed(2)})</h3><p className="field-note">Your open copy will add the same share after the skip window. {Date.parse(selected.pendingAdd.skipUntil) > now ? `Skip within ${Math.max(0, Math.ceil((Date.parse(selected.pendingAdd.skipUntil) - now) / 1000))} seconds.` : 'The add is processing.'}</p>{Date.parse(selected.pendingAdd.skipUntil) > now && <button className="outline full" disabled={!!busy} onClick={skipAdd}>Skip this add</button>}</>}{selected.venue === 'perpl' && !!selected.suggestions?.length && <><div className="trade-divider" /><h3>Clan suggestions</h3><div className="suggestion-list">{selected.suggestions.map(suggestion => <div className="suggestion-row" key={suggestion.id}><div><strong>{suggestion.fromName}</strong><span>TP {dollars(suggestion.takeProfitPrice)} · SL {dollars(suggestion.stopLossPrice)}</span><small>{new Date(suggestion.createdAt).toLocaleString()}</small></div><button className="outline" disabled={!!busy} onClick={() => applySuggestion(suggestion)}>Apply</button></div>)}</div></>}<div className="trade-divider" /><h3>Share this result</h3><label className="switch-row"><span>Show clan name</span><input type="checkbox" checked={shareWithClan} onChange={event => setShareWithClan(event.target.checked)} /></label><button className="outline full" disabled={!!busy} onClick={share}><ExternalLink size={15} /> Create public card</button>{shareUrl && <a className="share-link" href={shareUrl} target="_blank" rel="noreferrer">Open public result <ExternalLink size={14} /></a>}</>}</> : <div className="trade-ticket"><div className="detail-section-label">YOUR OWN TRADE</div><h2>{market?.symbol ?? 'Select a market'}</h2><p className="detail-sub">{market ? venueName(market.venue) : 'Your account'}</p>{market?.venue === 'perpl' && <div className="funding-modes"><button className={tradeSide === 'long' ? 'active' : ''} onClick={() => setTradeSide('long')}>Long</button><button className={tradeSide === 'short' ? 'active' : ''} onClick={() => setTradeSide('short')}>Short</button></div>}<label className="field-label" htmlFor="trade-amount">{market?.venue === 'nadfun' ? 'BUY SIZE / $' : 'MARGIN / $'}</label><input id="trade-amount" type="number" min="1" value={tradeAusd} onChange={event => setTradeAusd(event.target.value)} />{market?.venue === 'perpl' && <><label className="field-label" htmlFor="trade-leverage">LEVERAGE</label><input id="trade-leverage" type="number" min="1" max={market.maxLeverage} value={tradeLeverage} onChange={event => setTradeLeverage(event.target.value)} /></>}{market?.venue === 'nadfun' && <p className="field-note">{me?.balances?.memesPayWith === 'ausd' ? 'Paid from wallet dollars. Keep MON for gas.' : 'Paid in MON from your wallet.'} {config?.monPriceAusd ? `1 MON = ${dollars(config.monPriceAusd)}` : 'MON price unavailable.'}</p>}<button className="primary full" disabled={!!busy || !market} onClick={openTrade}>{market?.venue === 'nadfun' ? 'Buy token' : 'Open position'} <ArrowRight size={16} /></button><div className="trade-divider" /><h3>Clan positions</h3><p className="field-note">Select a marker on the chart to inspect or stack it manually.</p></div>}</div> : panel === 'members' ? <div className="detail-body"><div className="detail-section-label">CLAN TRACK RECORD</div><h2>Clan members</h2><div className="member-list">
        {snapshot?.members.map(member => <div className="member-row" key={member.id}>
          <div className="member-top"><span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}</strong><small>{shortAddress(member.address)}</small></div>{member.verified ? <ShieldCheck size={15} className="verified" /> : <small className="unverified">UNVERIFIED</small>}</div>
          <div className="member-stats"><span>WIN RATE<strong>{member.verified ? percent(member.winRate == null ? null : member.winRate * 100) : '—'}</strong></span><span>OWN TRADES<strong>{member.verified ? member.tradeCount : '—'}</strong></span><span>REALIZED PNL<strong className={(member.realizedPnlUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{member.verified && member.realizedPnlUsd != null ? signedDollars(member.realizedPnlUsd) : '—'}</strong></span></div>
          {member.verified ? <><div className="member-venues"><span>Perpl <strong>{signedDollars(member.stats.realizedPnlPerplUsd)}</strong></span><span>Nad.fun <strong>{signedMon(member.stats.realizedPnlMon)}</strong></span></div><div className="member-copied"><span>{member.stats.copied.tradeCount ? `+${member.stats.copied.tradeCount}` : '0'} copied</span>{member.stats.copied.winRate != null && <span>{percent(member.stats.copied.winRate * 100)} win rate</span>}{member.stats.copied.realizedPnlUsd != null && <span>{signedDollars(member.stats.copied.realizedPnlUsd)}</span>}</div></> : <p className="member-trades">Track record awaits indexer verification.</p>}
        </div>)}
        {!snapshot?.members.length && <p className="field-note">Member records will appear after the indexer syncs.</p>}
      </div></div> : panel === 'chat' ? <ClanChat key={clanId ?? ''} clanId={clanId!} liveMessage={liveMessage} selectedMarker={selected} onOpenMarker={openLinkedMarker} /> : panel === 'clan' ? <div className="detail-body">
      <div className="detail-section-label">PRIVATE CLAN</div>
      <h2>Mirror policy</h2>
      <p className="detail-sub">{clan?.name}</p>
      <p className="field-note">Changing these limits requires your wallet signature. Your account and funds remain yours.</p>
      {editPolicy ? <>
        <label className="switch-row"><span>Auto mirror</span><input type="checkbox" checked={editPolicy.enabled} onChange={event => setEditPolicy({ ...editPolicy, enabled: event.target.checked })} /></label>
        <div className="policy-fields"><label><span className="field-label">UP TO % OF BALANCE</span><input type="number" min="1" max="100" value={editPolicy.balancePercentCap} onChange={event => setEditPolicy({ ...editPolicy, balancePercentCap: Number(event.target.value) })} /></label><label><span className="field-label">MAX $ PER TRADE</span><input type="number" min="1" max="1000000" value={editPolicy.maxUsdPerTrade} onChange={event => setEditPolicy({ ...editPolicy, maxUsdPerTrade: Number(event.target.value) })} /></label></div>
        <button className="primary full" disabled={!!busy || JSON.stringify(editPolicy) === JSON.stringify(clan?.myPolicy)} onClick={savePolicy}>Sign policy update</button>
        {clan?.myPolicy && editPolicy.maxUsdPerTrade > clan.myPolicy.maxUsdPerTrade && <p className="field-note">A higher cap also requires a fresh capped signer approval in your wallet.</p>}
      </> : <p className="field-note">Your policy is unavailable. Refresh your clan before changing it.</p>}
      <div className="trade-divider" />
      <h3>Leave clan</h3>
      <p className="field-note">Pending mirrors are cancelled. Open mirrors still unwind when their leader exits.</p>
      {!confirmLeave ? <button className="outline full danger-button" disabled={!!busy} onClick={() => setConfirmLeave(true)}>Leave clan</button> : <><p className="wallet-warning">Leave {clan?.name}? This removes your access to its chart and invite.</p><div className="leave-actions"><button className="outline" disabled={!!busy} onClick={() => setConfirmLeave(false)}>Cancel</button><button className="outline danger-button" disabled={!!busy} onClick={leave}>Confirm leave</button></div></>}
    </div> : <div className="detail-body">
      <div className="detail-section-label">YOUR OWN ACCOUNT</div>
      <h2>Trading wallet</h2>
      <p className="detail-sub">{shortAddress(wallet.address)} · Monad {config?.chainId === 10143 ? 'testnet' : ''}</p>
      <div className="pnl-block"><span>PERPL MARGIN</span><strong>{me?.balances ? dollars(me.balances.perplMarginUsd) : setup ? dollars(Number(setup.collateralBalance) / 1_000_000) : '—'}</strong></div>
      <div className="stat-pair"><span>WALLET DOLLARS</span><strong>{dollars(me?.balances?.walletUsd)}</strong></div><div className="stat-pair"><span>MON BALANCE VALUE</span><strong>{me?.balances ? dollars(me.balances.monUsd) : balanceMon != null && config?.monPriceAusd != null ? dollars(balanceMon * config.monPriceAusd) : '—'}</strong></div>
      {lowGas && <><p className="wallet-warning">Low MON for gas. Keep at least {gasReserveMon} MON before trading or mirroring.</p><button className="outline full" onClick={() => navigator.clipboard.writeText(wallet.address).then(() => setNotice('Wallet address copied for MON top-up.'))}><Copy size={15} /> Copy address for MON top-up</button></>}
      <div className="stat-pair"><span>PERPL SETUP</span><strong>{setup?.step.replaceAll('_', ' ') ?? 'Unavailable'}</strong></div>
      <div className="trade-divider" />
      <h3>Backend trading signer</h3>
      <p className="field-note">Your wallet approves a capped signer for clan mirrors and Nad.fun trades. It cannot withdraw or transfer your funds.</p>
      {grant && <><div className="stat-pair"><span>PERPL DEPOSIT CAP</span><strong>{dollars(grant.capAusd)} per transaction</strong></div><div className="stat-pair"><span>NAD.FUN BUY CAP</span><strong>{dollars(grant.maxBuyMon * grant.monPriceAusd)} per buy</strong></div><p className="field-note">At {dollars(grant.monPriceAusd)} per MON when this policy was granted.</p></>}
      <button className="outline full" disabled={!!busy || !clanId} onClick={() => perform('grant-signer', async () => { if (signerUnknown) { await loadMe(); setNotice('Signer status refreshed.'); } else { const confirmed = await grantSigner(); setNotice(confirmed ? 'Trading signer is active.' : 'Signer approval is awaiting Privy verification.'); } })}><ShieldCheck size={15} /> {signerUnknown ? 'Refresh signer status' : signerReady ? 'Reconfirm signer' : signerPrompt}</button>
      {!signerReady && <p className="wallet-warning">{signerPrompt} · Nad.fun copies cannot run until your wallet confirms this signer and policy.</p>}
      <div className="trade-divider" />
      <h3>Fund your account</h3>
      <div className="funding-modes"><button className={fundMode === 'ausd' ? 'active' : ''} onClick={() => setFundMode('ausd')}>Deposit AUSD</button><button className={fundMode === 'usdc' ? 'active' : ''} onClick={() => setFundMode('usdc')}>Pay with USDC</button></div>
      {fundMode === 'ausd' ? <><p className="field-note">Send the deposit token on Monad {config?.chainId === 10143 ? 'testnet' : 'mainnet'} to your own wallet. Wallet dollars fund meme buys; move collateral into Perpl during setup for perps.</p><div className="deposit-address">{wallet.address}</div>{config?.chainId === 10143 && <><span className="field-label">TOKEN CONTRACT</span><div className="deposit-address">{testnetAusd}</div></>}<button className="outline full" onClick={() => navigator.clipboard.writeText(wallet.address).then(() => setNotice('Wallet address copied.'))}><Copy size={15} /> Copy deposit address</button>{setup && <p className="field-note">Account opening needs {dollars(Number(setup.minAccountOpen) / 1_000_000)}. Keep MON for gas.</p>}</> : <><p className="wallet-warning">Kuru Flow routes USDC to dollars on mainnet. This path is unavailable on testnet; no wallet action starts without a backend plan.</p><div className="funding-modes"><button className={fundDestination === 'wallet' ? 'active' : ''} onClick={() => { setFundDestination('wallet'); setFundingPlan(null); }}>Wallet dollars</button><button className={fundDestination === 'perpl' ? 'active' : ''} onClick={() => { setFundDestination('perpl'); setFundingPlan(null); }}>Perpl margin</button></div><label className="field-label" htmlFor="fund-size">AMOUNT / USDC</label><input id="fund-size" type="number" min="1" value={fundUsd} onChange={event => { setFundUsd(event.target.value); setFundingPlan(null); }} /><button className="outline full" disabled={!!busy || config?.chainId !== 143} onClick={buyUsdc}>Buy USDC by card</button>{fundingConfirmation ? <><p className="wallet-warning">Transactions were sent. Retry confirmation without signing them again.</p><button className="primary full" disabled={!!busy} onClick={() => perform('confirm-fund', () => confirmFunding(fundingConfirmation))}>Retry confirmation</button></> : fundingPlan ? <><div className="funding-quote"><div className="stat-pair"><span>EXPECTED</span><strong>{dollars(Number(formatUnits(BigInt(fundingPlan.expectedAusdOut), 6)))}</strong></div><div className="stat-pair"><span>GUARANTEED MINIMUM</span><strong>{dollars(Number(formatUnits(BigInt(fundingPlan.minAusdOut), 6)))}</strong></div><p className="field-note">To {fundingPlan.depositToPerpl ? 'Perpl margin' : 'your wallet'} · expires {new Date(fundingPlan.expiresAt).toLocaleTimeString()}</p></div><button className="primary full" disabled={!!busy} onClick={executeFunding}><ArrowDownToLine size={16} /> Sign {fundingPlan.actions.length} wallet actions</button><button className="outline full" disabled={!!busy} onClick={() => setFundingPlan(null)}>Cancel route</button></> : <button className="primary full" disabled={!!busy || !clanId || config?.chainId !== 143} onClick={prepareFunding}><ArrowDownToLine size={16} /> Review USDC route</button>}</>}
      <div className="trade-divider" />
      <h3>Perpl authorization</h3>
      <p className="field-note">Your wallet signs account creation, forwarding, and one trading-key enrollment. The backend cannot sign these steps for you.</p>
      <button className="outline full" disabled={!!busy} onClick={enroll}><ShieldCheck size={15} /> {setup?.step === 'ready' ? 'Perpl ready' : 'Continue Perpl setup'}</button>
      <div className="trade-divider" />
      <h3>Your holdings</h3>
      {holdings.length ? holdings.map(holding => <div className="holding-row" key={`${holding.venue}:${holding.market}`}><div><strong>{holding.symbol}</strong><small>{venueName(holding.venue)} · {holding.side.toUpperCase()} · {holding.size}</small></div><div><strong>{dollars(holding.valueAusd)}</strong><small>{holding.pnlAusd == null ? 'PnL pending' : signedDollars(holding.pnlAusd)}</small></div><button className="outline" disabled={!!busy} onClick={() => closeTrade(holding)}>Close</button></div>) : <p className="field-note">No live holdings in your account.</p>}      {clan && <><div className="trade-divider" /><h3>Invite link</h3><button className="outline full" onClick={copyInvite}><Copy size={15} /> Copy private invite</button></>}
    </div>}</aside></div>
    {(error || notice) && <div className={`toast ${error ? 'error' : ''}`} role="status">{error ?? notice}<button className="icon-button compact" title="Dismiss" onClick={() => { setError(null); setNotice(null); }}><X size={14} /></button></div>}
    {busy && <div className="busy-bar"><span>{busy === 'stack' ? 'Authorizing your trade' : busy === 'fund' ? 'Preparing wallet funding' : busy === 'join' ? 'Signing clan authorization' : 'Working'}…</span></div>}
  </div>;
}
