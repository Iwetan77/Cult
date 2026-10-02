'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Check, RefreshCw, X } from 'lucide-react';
import { getAccessToken } from '@/lib/auth';
import { getDeposit, withdraw } from '@/lib/api';
import type { DepositInfo, WithdrawRequest, WithdrawResult } from '@/lib/contracts';
import { isDemo } from '@/lib/demo';
import { dollars } from '@/lib/format';
import { TokenLogo } from './TokenLogo';

// Send wallet tokens to another address: pick a token, amount and address,
// review, confirm. Works in the demo only for now; real accounts see the
// form with a "coming soon" note, since a real withdrawal must be signed by
// the member's own wallet and that flow isn't built yet.

type Props = { onClose: () => void; onDone: () => void; gasReserveMon: number };
type Symbol = WithdrawRequest['symbol'];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const tokenAmount = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
const shortHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

export function WithdrawSheet({ onClose, onDone, gasReserveMon }: Props) {
  const demo = isDemo();
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

  useEffect(() => {
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to see your wallet.');
      return getDeposit(token);
    }).then(value => {
      if (!active) return;
      setInfo(value); setError(null);
      setSymbol(current => current ?? value.tokens.find(token => token.balance > 0)?.symbol ?? null);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Wallet details unavailable.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const token = info?.tokens.find(item => item.symbol === symbol) ?? null;
  // MON pays gas, so a little always stays behind.
  const available = token ? Math.max(0, token.symbol === 'MON' ? token.balance - gasReserveMon : token.balance) : 0;
  const amount = Number(amountText);
  const unitUsd = token && token.balance > 0 && token.balanceUsd != null ? token.balanceUsd / token.balance : null;
  const amountUsd = unitUsd != null && amount > 0 ? amount * unitUsd : null;
  const ownAddress = !!info && to.trim().toLowerCase() === info.address.toLowerCase();
  const amountError = !amountText ? null : !(amount > 0) ? 'Enter an amount above zero.' : amount > available + 1e-9 ? 'More than you have available.' : null;
  const addressError = !to.trim() ? null : !ADDRESS.test(to.trim()) ? 'That doesn’t look like a Monad address (0x followed by 40 characters).' : ownAddress ? 'That’s your own Cult wallet.' : null;
  const valid = !!token && amount > 0 && !amountError && ADDRESS.test(to.trim()) && !ownAddress;

  const confirm = async () => {
    if (!token) return;
    setSending(true); setError(null);
    try {
      const authToken = await getAccessToken();
      if (!authToken) throw new Error('Sign in again to withdraw.');
      setResult(await withdraw(authToken, { symbol: token.symbol, amount, to: to.trim() }));
      setStep('done');
      onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Withdrawal failed.'); }
    finally { setSending(false); }
  };

  return <div className="modal-backdrop deposit-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="deposit-sheet" role="dialog" aria-modal="true" aria-label="Withdraw">
      <div className="trade-sheet-head">
        {step === 'review' ? <button className="icon-btn" title="Back" onClick={() => { setStep('form'); setError(null); }}><ArrowLeft size={18} /></button> : <span className="eyebrow">YOUR WALLET</span>}
        <button className="icon-btn" title="Close withdraw" onClick={onClose}><X size={18} /></button>
      </div>
      <h2>{step === 'review' ? 'Review' : step === 'done' ? 'Sent' : 'Withdraw'}</h2>

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
          <button className="btn btn-primary btn-lg btn-block" disabled={sending} onClick={() => void confirm()}>{sending ? 'Sending…' : `Withdraw ${tokenAmount(amount)} ${token.symbol}`}</button>
        </>
        : <>
          {!demo && <div className="deposit-permission"><strong>Withdrawals are coming soon</strong><p className="field-note">You can try the full flow in the demo. Real withdrawals will be signed by your own wallet.</p></div>}
          <div className="field">
            <span className="field-label">Token</span>
            <div className="deposit-tokens">{info.tokens.map(item => <button key={item.symbol} type="button" className={`deposit-token withdraw-token ${symbol === item.symbol ? 'on' : ''}`} disabled={item.balance <= 0} onClick={() => { setSymbol(item.symbol); setAmountText(''); }}>
              <TokenLogo symbol={item.symbol} className="deposit-token-icon" />
              <span className="deposit-token-name"><strong>{item.name}</strong><small>{item.balance > 0 ? item.what : 'Nothing to withdraw'}</small></span>
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
          <button className="btn btn-primary btn-lg btn-block" disabled={!valid || !demo} onClick={() => { setError(null); setStep('review'); }}>Review withdrawal</button>
        </>}
    </section>
  </div>;
}
