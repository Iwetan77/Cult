'use client';

import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, RefreshCw } from './icons';
import { getAccessToken } from '@/lib/auth';
import { ApiError, getIntentChains, getIntentStatus, prepareIntentWithdraw, quoteIntentDeposit, submitIntentDeposit } from '@/lib/api';
import { PinPad } from './PinPad';
import type { IntentChain, IntentStatus, IntentSwap, IntentWithdraw, WalletAction } from '@/lib/contracts';
import { dollars } from '@/lib/format';

// Money in from, and out to, other chains (Aurora Intents). In: pick a coin
// on another chain, send it to a one-time address from any wallet or
// exchange; it lands as USDC in the Cult wallet, which becomes trading dollars
// by itself. Out: dollars leave as the coin and chain picked.

const token = async () => {
  const value = await getAccessToken();
  if (!value) throw new Error('Sign in again to continue.');
  return value;
};
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Something went wrong.';

function useChains() {
  const [chains, setChains] = useState<IntentChain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    token().then(getIntentChains).then(r => { if (active) { setChains(r.enabled ? r.chains : []); setError(null); } })
      .catch(reason => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [revision]);
  return { chains, error, retry: () => setRevision(value => value + 1) };
}

function CoinPicker({ chains, chain, assetId, onChain, onAsset }: { chains: IntentChain[]; chain: string; assetId: string; onChain: (chain: string) => void; onAsset: (assetId: string) => void }) {
  const current = chains.find(c => c.chain === chain);
  return <div className="xchain-pick">
    <label className="field"><span className="field-label">Network</span>
      <select className="xchain-select" value={chain} onChange={event => onChain(event.target.value)}>{chains.map(c => <option key={c.chain} value={c.chain}>{c.name}</option>)}</select></label>
    <label className="field"><span className="field-label">Coin</span>
      <select className="xchain-select" value={assetId} onChange={event => onAsset(event.target.value)}>{current?.tokens.map(t => <option key={t.assetId} value={t.assetId}>{t.symbol}</option>)}</select></label>
  </div>;
}

const STATUS_TEXT: Record<IntentStatus['status'], string> = {
  PENDING_DEPOSIT: 'Waiting for your transfer',
  KNOWN_DEPOSIT_TX: 'Transfer seen, confirming',
  INCOMPLETE_DEPOSIT: 'Less arrived than quoted. It will be refunded',
  PROCESSING: 'Moving across chains',
  SUCCESS: 'Arrived',
  REFUNDED: 'Refunded',
  FAILED: 'Failed',
};

// Follows one transfer until it settles.
function Tracker({ swap, done }: { swap: IntentSwap; done?: (status: IntentStatus) => void }) {
  const [status, setStatus] = useState<IntentStatus | null>(null);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const tick = async () => {
      const next = await token().then(t => getIntentStatus(t, swap.depositAddress)).catch(() => null);
      if (!active) return;
      if (next) setStatus(next);
      if (next?.done) { done?.(next); return; }
      timer = window.setTimeout(() => void tick(), 6000);
    };
    void tick();
    return () => { active = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one tracker per deposit address
  }, [swap.depositAddress]);
  const s = status?.status ?? swap.status;
  return <div className={`xchain-status ${s === 'SUCCESS' ? 'up' : s === 'FAILED' || s === 'REFUNDED' || s === 'INCOMPLETE_DEPOSIT' ? 'down' : ''}`}>
    {s === 'SUCCESS' ? <Check size={15} /> : <span className="button-spinner" aria-hidden="true" />}
    <span>{STATUS_TEXT[s]}{s === 'SUCCESS' && status?.received ? `: ${status.received} ${swap.receiveSymbol}` : ''}{s === 'REFUNDED' && status?.refunded ? `: ${status.refunded} ${swap.symbol}` : ''}</span>
    {status?.txs.slice(-1).map(t => t.url ? <a key={t.hash} className="link" href={t.url} target="_blank" rel="noreferrer">View</a> : null)}
  </div>;
}

export function CrossChainDeposit() {
  const { chains, error: loadError, retry } = useChains();
  const [chain, setChain] = useState('');
  const [assetId, setAssetId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [quote, setQuote] = useState<IntentSwap | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!chains?.length || chain) return;
    setChain(chains[0]!.chain);
    setAssetId(chains[0]!.tokens[0]?.assetId ?? '');
  }, [chains, chain]);
  const current = chains?.find(c => c.chain === chain);
  const coin = current?.tokens.find(t => t.assetId === assetId);
  const amount = Number(amountText);
  const worth = coin?.priceUsd != null && amount > 0 ? amount * coin.priceUsd : null;

  if (loadError) return <><p className="notice-line">{loadError}</p><button className="btn btn-ghost" onClick={retry}><RefreshCw size={14} /> Retry</button></>;
  if (!chains) return <p className="field-note">Loading networks…</p>;
  if (!chains.length) return <p className="field-note">Deposits from other chains aren’t switched on yet.</p>;

  const getAddress = async () => {
    setBusy(true); setError(null);
    try { setQuote(await quoteIntentDeposit(await token(), assetId, amountText, refundTo.trim() || undefined)); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(value); } catch { setError('Could not copy. Select it manually.'); }
  };

  if (quote) return <div className="xchain">
    <p className="deposit-instruction">Send exactly <strong>{quote.amountIn} {quote.symbol}</strong> on <strong>{quote.chainName}</strong> to this address, from any wallet or exchange.</p>
    <div className="deposit-qr"><QRCodeSVG value={quote.depositAddress} size={168} level="M" bgColor="#ffffff" fgColor="#151820" /></div>
    <div className="deposit-address-large">{quote.depositAddress}</div>
    <button className="btn btn-ghost btn-block" onClick={() => void copy(quote.depositAddress)}><Copy size={15} /> {copied === quote.depositAddress ? 'Copied' : 'Copy address'}</button>
    {quote.depositMemo && <><div className="deposit-address-large">Memo: {quote.depositMemo}</div><p className="withdraw-error">Include this memo or the deposit is lost.</p></>}
    <div className="withdraw-review">
      <div><span>You get</span><strong>about {quote.receive} USDC{quote.receiveUsd != null ? ` (${dollars(quote.receiveUsd)})` : ''}</strong></div>
      <div><span>Arrives in</span><strong>about {Math.max(1, Math.round(quote.seconds / 60))} min</strong></div>
      <div><span>Send before</span><strong>{new Date(quote.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong></div>
    </div>
    <p className="field-note">It lands in your Cult wallet as USDC and becomes dollars to trade with automatically. Use this address once.</p>
    <Tracker swap={quote} />
    <button className="btn btn-ghost btn-block" onClick={() => { setQuote(null); setCopied(null); }}>New deposit</button>
  </div>;

  return <div className="xchain">
    <CoinPicker chains={chains} chain={chain} assetId={assetId} onChain={next => { setChain(next); setAssetId(chains.find(c => c.chain === next)?.tokens[0]?.assetId ?? ''); }} onAsset={setAssetId} />
    <div className="field">
      <div className="field-top"><span className="field-label">Amount</span><small>{worth != null ? `≈ ${dollars(worth)}` : coin?.symbol}</small></div>
      <label className="ticket-input"><input inputMode="decimal" placeholder="0" value={amountText} aria-label={`Amount in ${coin?.symbol ?? 'coins'}`} onChange={event => setAmountText(event.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} /><span className="withdraw-unit">{coin?.symbol}</span></label>
    </div>
    {current && !current.evm && <label className="field"><span className="field-label">Refund address on {current.name} (optional)</span><input placeholder="Where to send it back if anything goes wrong" value={refundTo} spellCheck={false} autoComplete="off" onChange={event => setRefundTo(event.target.value)} /></label>}
    {error && <p className="notice-line" role="status">{error}</p>}
    <button className="btn btn-primary btn-lg btn-block" disabled={busy || !(amount > 0) || !assetId} onClick={() => void getAddress()}>{busy ? 'Getting an address…' : 'Get deposit address'}</button>
  </div>;
}

export function CrossChainWithdraw({ walletUsd, onSend, onDone }: { walletUsd: number; onSend: (actions: WalletAction[]) => Promise<string>; onDone: () => void }) {
  const { chains, error: loadError, retry } = useChains();
  const [chain, setChain] = useState('');
  const [assetId, setAssetId] = useState('');
  const [usdText, setUsdText] = useState('');
  const [recipient, setRecipient] = useState('');
  const [plan, setPlan] = useState<IntentWithdraw | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askPin, setAskPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  useEffect(() => {
    if (!chains?.length || chain) return;
    setChain(chains[0]!.chain);
    setAssetId(chains[0]!.tokens[0]?.assetId ?? '');
  }, [chains, chain]);
  const current = chains?.find(c => c.chain === chain);
  const coin = current?.tokens.find(t => t.assetId === assetId);
  const amount = Number(usdText);
  const problem = useMemo(() => !usdText ? null : !(amount >= 5) ? 'The smallest cross-chain withdrawal is $5.' : amount > walletUsd + 1e-6 ? `You have ${dollars(walletUsd)} in your wallet.` : null, [usdText, amount, walletUsd]);

  if (loadError) return <><p className="notice-line">{loadError}</p><button className="btn btn-ghost" onClick={retry}><RefreshCw size={14} /> Retry</button></>;
  if (!chains) return <p className="field-note">Loading networks…</p>;
  if (!chains.length) return <p className="field-note">Withdrawals to other chains aren’t switched on yet.</p>;

  // Money leaving Cult: the member's PIN before the plan is made.
  const review = async (pin: string) => {
    setBusy('review'); setError(null); setPinError(null);
    try { setPlan(await prepareIntentWithdraw(await token(), assetId, amount, recipient.trim(), pin)); setAskPin(false); }
    catch (reason) {
      if (reason instanceof ApiError && reason.code?.startsWith('pin_')) setPinError(reason.message);
      else { setAskPin(false); setError(message(reason)); }
    }
    finally { setBusy(null); }
  };
  const send = async () => {
    if (!plan) return;
    setBusy('send'); setError(null);
    try {
      const hash = await onSend(plan.actions);
      setSent(true);
      onDone();
      void token().then(t => submitIntentDeposit(t, plan.depositAddress, hash)).catch(() => undefined);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(null); }
  };

  if (plan) return <div className="xchain">
    <div className="withdraw-review">
      <div><span>You send</span><strong>{dollars(amount)}</strong></div>
      <div><span>They get</span><strong>about {plan.receive} {plan.receiveSymbol}{plan.receiveUsd != null ? ` (${dollars(plan.receiveUsd)})` : ''}</strong></div>
      <div><span>Network</span><strong>{plan.chainName}</strong></div>
      <div><span>Arrives in</span><strong>about {Math.max(1, Math.round(plan.seconds / 60))} min</strong></div>
    </div>
    <div className="field"><span className="field-label">To</span><div className="deposit-address-large">{recipient.trim()}</div></div>
    <p className="field-note">Check the address. Transfers can’t be reversed. Your wallet signs {plan.actions.length === 1 ? 'one transaction' : `${plan.actions.length} transactions`} on Monad.</p>
    {error && <p className="notice-line" role="status">{error}</p>}
    {sent ? <Tracker swap={plan} /> : <button className="btn btn-primary btn-lg btn-block" disabled={!!busy} onClick={() => void send()}>{busy === 'send' ? 'Sending…' : `Send to ${plan.chainName}`}</button>}
    {!sent && <button className="btn btn-ghost btn-block" disabled={!!busy} onClick={() => setPlan(null)}>Back</button>}
  </div>;

  return <div className="xchain">
    <CoinPicker chains={chains} chain={chain} assetId={assetId} onChain={next => { setChain(next); setAssetId(chains.find(c => c.chain === next)?.tokens[0]?.assetId ?? ''); }} onAsset={setAssetId} />
    <div className="field">
      <div className="field-top"><span className="field-label">Amount</span><small>Available {dollars(walletUsd)}</small></div>
      <label className="ticket-input"><span className="ticket-prefix">$</span><input inputMode="decimal" placeholder="0" value={usdText} aria-label="Amount in dollars" onChange={event => setUsdText(event.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} /><button type="button" className="ticket-unit" onClick={() => setUsdText(String(Math.floor(walletUsd * 100) / 100))}>Max</button></label>
      {problem ? <small className="withdraw-error">{problem}</small> : <small className="withdraw-hint">Arrives as {coin?.symbol ?? 'the coin you pick'} on {current?.name ?? 'that network'}.</small>}
    </div>
    <label className="field"><span className="field-label">{current?.name ?? ''} address</span><input placeholder={current?.evm ? '0x…' : 'Recipient address'} value={recipient} spellCheck={false} autoComplete="off" onChange={event => setRecipient(event.target.value)} /></label>
    {error && <p className="notice-line" role="status">{error}</p>}
    {askPin ? <PinPad title="Enter your PIN" note={`To send ${dollars(amount)} to ${current?.name ?? 'another chain'}`} error={pinError} busy={busy === 'review'} onComplete={review} />
      : <button className="btn btn-primary btn-lg btn-block" disabled={!!busy || !usdText || !!problem || !recipient.trim() || !assetId} onClick={() => { setAskPin(true); setPinError(null); }}>Review</button>}
  </div>;
}
