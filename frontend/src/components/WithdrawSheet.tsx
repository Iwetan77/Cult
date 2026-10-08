'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Check, RefreshCw, X } from './icons';
import { getAccessToken } from '@/lib/auth';
import { ApiError, getDeposit, withdraw } from '@/lib/api';
import type { DepositInfo, WalletAction, WithdrawRequest, WithdrawResult } from '@/lib/contracts';
import { CrossChainWithdraw } from './CrossChain';
import { isDemo } from '@/lib/demo';
import { dollars } from '@/lib/format';
import { TokenLogo } from './TokenLogo';
import { PinPad } from './PinPad';

// Send wallet tokens to another address: pick a token, amount and address,
// review, confirm. The backend can't move funds, so it hands back the send
// and the member's own wallet signs it (onSend). With cross-chain on, the
// money can also leave to another chain (Aurora Intents).

// predictionsUsd / onBringBack: money in the predictions account (Polygon) is
// part of the one balance; one tap brings it back to the wallet first.
type Props = { onClose: () => void; onDone: () => void; gasReserveMon: number; onSend?: (actions: WalletAction[]) => Promise<string>; crossChain?: boolean; predictionsUsd?: number | null; onBringBack?: (amountUsd: number) => Promise<void> };
type Symbol = WithdrawRequest['symbol'];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const tokenAmount = (value: number | null) => value == null ? 'Unavailable' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
const shortHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

export function WithdrawSheet({ onClose, onDone, gasReserveMon, onSend, crossChain = false, predictionsUsd = null, onBringBack }: Props) {
  const demo = isDemo();
  const [network, setNetwork] = useState<'monad' | 'other'>('monad');
  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<Symbol | null>(null);
  const [amountText, setAmountText] = useState('');
  const [to, setTo] = useState('');
  const [step, setStep] = useState<'form' | 'review' | 'done'>('form');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const [bringing, setBringing] = useState<'busy' | 'sent' | null>(null);
  const inPredictions = Math.floor((predictionsUsd ?? 0) * 100) / 100;
  const bringBack = async () => {
    if (!onBringBack) return;
    setBringing('busy'); setError(null);
    try {
      await onBringBack(inPredictions);
      setBringing('sent');
      // Lands in about half a minute; then the wallet's tokens refresh.
      window.setTimeout(() => setRevision(value => value + 1), 35_000);
    } catch (reason) { setBringing(null); setError(reason instanceof Error ? reason.message : 'Could not move it back.'); }
  };

  useEffect(() => {
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to see your wallet.');
      return getDeposit(token);
    }).then(value => {
      if (!active) return;
      setInfo(value); setError(null);
      setSymbol(current => current ?? value.tokens.find(token => token.depositSupported !== false && token.balance != null && token.balance > 0)?.symbol ?? null);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Wallet details unavailable.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const token = info?.tokens.find(item => item.symbol === symbol && item.depositSupported !== false) ?? null;
  // MON pays gas, so a little always stays behind.
  const available = token?.balance != null ? Math.max(0, token.symbol === 'MON' ? token.balance - gasReserveMon : token.balance) : 0;
  const amount = Number(amountText);
  const unitUsd = token?.balance != null && token.balance > 0 && token.balanceUsd != null ? token.balanceUsd / token.balance : null;
  const amountUsd = unitUsd != null && amount > 0 ? amount * unitUsd : null;
  const ownAddress = !!info && to.trim().toLowerCase() === info.address.toLowerCase();
  const amountError = !amountText ? null : !(amount > 0) ? 'Enter an amount above zero.' : amount > available + 1e-9 ? 'More than you have available.' : null;
  const addressError = !to.trim() ? null : !ADDRESS.test(to.trim()) ? 'That doesn’t look like a Monad address (0x followed by 40 characters).' : ownAddress ? 'That’s your own Cult wallet.' : null;
  const valid = !!token && amount > 0 && !amountError && ADDRESS.test(to.trim()) && !ownAddress;

  // Money leaving Cult: the last tap asks for the member's PIN.
  const [askPin, setAskPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const confirm = async (pin: string) => {
    if (!token) return;
    setSending(true); setError(null); setPinError(null);
    try {
      const authToken = await getAccessToken();
      if (!authToken) throw new Error('Sign in again to withdraw.');
      let sent;
      try { sent = await withdraw(authToken, { symbol: token.symbol, amount, to: to.trim(), pin }); }
      catch (reason) {
        if (reason instanceof ApiError && reason.code?.startsWith('pin_')) { setPinError(reason.message); return; }
        throw reason;
      }
      if ('tx' in sent) setResult(sent);
      else {
        if (!onSend) throw new Error('Your wallet is not connected.');
        setResult({ symbol: sent.symbol, amount: sent.amount, to: sent.to, tx: await onSend(sent.actions) });
      }
      setStep('done');
      onDone();
    } catch (reason) { setAskPin(false); setError(reason instanceof Error ? reason.message : 'Withdrawal failed.'); }
    finally { setSending(false); }
  };

  return <div className="modal-backdrop deposit-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="deposit-sheet" role="dialog" aria-modal="true" aria-label="Withdraw">
      <div className="trade-sheet-head">
        {step === 'review' && <button className="icon-btn" title="Back" onClick={() => { setStep('form'); setError(null); setAskPin(false); }}><ArrowLeft size={18} /></button>}
        <h2>{step === 'review' ? 'Review' : step === 'done' ? 'Sent' : 'Withdraw'}</h2>
        <button className="icon-btn" title="Close withdraw" onClick={onClose}><X size={18} /></button>
      </div>

      {loading ? <p className="field-note">Loading your wallet...</p>
        : !info ? <><p className="notice-line">{error}</p><button className="btn btn-ghost" onClick={() => { setLoading(true); setRevision(value => value + 1); }}><RefreshCw size={14} /> Retry</button></>
        : step === 'done' && result ? <div className="withdraw-done">
          <span className="withdraw-done-mark"><Check size={30} /></span>
          <p><strong>{tokenAmount(result.amount)} {result.symbol}</strong> is on its way to</p>
          <div className="deposit-address-large">{result.to}</div>
          <div className="withdraw-review">
            <div><span>Transaction</span><strong className="mono">{shortHash(result.tx)}</strong></div>
            <div><span>Network</span><strong>{info.network.name}</strong></div>
          </div>
          <button className="btn btn-primary btn-block" onClick={onClose}>Done</button>
        </div>
        : step === 'review' && token ? <>
          <div className="withdraw-review">
            <div><span>You send</span><strong>{tokenAmount(amount)} {token.symbol}</strong></div>
            {amountUsd != null && <div><span>Value</span><strong>{dollars(amountUsd)}</strong></div>}
            <div><span>Network</span><strong>{info.network.name}</strong></div>
            <div><span>Network fee</span><strong>Paid in MON</strong></div>
          </div>
          <div className="field"><span className="field-label">To</span><div className="deposit-address-large">{to.trim()}</div></div>
          <p className="field-note">Check the address. Transfers on {info.network.name} can&rsquo;t be reversed.</p>
          {error && <p className="notice-line" role="status">{error}</p>}
          {askPin ? <PinPad title="Enter your PIN" note={`To send ${tokenAmount(amount)} ${token.symbol}`} error={pinError} busy={sending} onComplete={confirm} />
            : <button className="btn btn-primary btn-lg btn-block" disabled={sending} onClick={() => { setAskPin(true); setPinError(null); }}>{`Withdraw ${tokenAmount(amount)} ${token.symbol}`}</button>}
        </>
        : <>
          {crossChain && <div className="seg seg--sm" role="tablist">
            <button role="tab" aria-selected={network === 'monad'} className={network === 'monad' ? 'on' : ''} onClick={() => setNetwork('monad')}>Monad</button>
            <button role="tab" aria-selected={network === 'other'} className={network === 'other' ? 'on' : ''} onClick={() => setNetwork('other')}>Another chain</button>
          </div>}
          {onBringBack && inPredictions >= 2 && <div className="xchain-status">
            <span>{bringing === 'sent' ? `${dollars(inPredictions)} is on its way to your wallet (about 30s).` : `${dollars(inPredictions)} is in predictions.`}</span>
            {bringing !== 'sent' && <button type="button" className="link" disabled={bringing === 'busy'} onClick={() => void bringBack()}>{bringing === 'busy' ? 'Bringing it back…' : 'Bring it to your wallet'}</button>}
          </div>}
          {network === 'other' && onSend ? <CrossChainWithdraw walletUsd={info.tokens.filter(t => t.depositSupported !== false && (t.symbol === 'AUSD' || t.symbol === 'USDC')).reduce((total, t) => total + (t.balance ?? 0), 0)} onSend={onSend} onDone={onDone} /> : <>
          <div className="field">
            <span className="field-label">Token</span>
            <div className="deposit-tokens">{info.tokens.filter(item => item.depositSupported !== false).map(item => <button key={item.symbol} type="button" className={`deposit-token withdraw-token ${symbol === item.symbol ? 'on' : ''}`} disabled={item.balance == null || item.balance <= 0} onClick={() => { setSymbol(item.symbol); setAmountText(''); }}>
              <TokenLogo symbol={item.symbol} className="deposit-token-icon" />
              <span className="deposit-token-name"><strong>{item.name}</strong><small>{item.balance == null ? 'Balance unavailable' : item.balance > 0 ? item.what : 'Nothing to withdraw'}</small></span>
              <span className="deposit-token-balance"><strong>{tokenAmount(item.balance)} {item.symbol}</strong><small>{dollars(item.balanceUsd)}</small></span>
            </button>)}</div>
          </div>

          {token && <div className="field">
            <div className="field-top"><span className="field-label">Amount</span><small>Available {tokenAmount(available)} {token.symbol}</small></div>
            <label className="ticket-input">
              <input inputMode="decimal" placeholder="0" value={amountText} aria-label={`Amount in ${token.symbol}`} onChange={event => setAmountText(event.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} />
              <span className="withdraw-unit">{token.symbol}</span>
              <button type="button" className="ticket-unit" onClick={() => setAmountText(String(Math.floor(available * 1e6) / 1e6))}>Max</button>
            </label>
            {amountError ? <small className="withdraw-error">{amountError}</small> : <small className="withdraw-hint">{amountUsd != null ? `≈ ${dollars(amountUsd)}` : token.symbol === 'MON' ? `${tokenAmount(gasReserveMon)} MON stays behind for gas` : ' '}</small>}
          </div>}

          <div className="field">
            <span className="field-label">To address</span>
            <input className="withdraw-address" placeholder="0x…" value={to} spellCheck={false} autoComplete="off" onChange={event => setTo(event.target.value)} />
            {addressError ? <small className="withdraw-error">{addressError}</small> : <small className="withdraw-hint">Only send to an address on {info.network.name}.</small>}
          </div>

          {(info.tradingAccountUsd ?? 0) > 0 && <p className="field-note">{dollars(info.tradingAccountUsd)} is in your trading account. Close positions to move it back to your wallet first.</p>}
          <button className="btn btn-primary btn-lg btn-block" disabled={!valid || (!demo && !onSend)} onClick={() => { setError(null); setStep('review'); }}>Review withdrawal</button>
          </>}
        </>}
    </section>
  </div>;
}
