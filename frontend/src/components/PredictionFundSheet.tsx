'use client';

import { useEffect, useState } from 'react';
import { Check, RefreshCw, X } from './icons';
import { getAccessToken } from '@/lib/auth';
import { fundPredictions, getPredictionAccount, setupPredictions, withdrawPredictions } from '@/lib/api';
import type { FlowStep, PredictionAccount, WalletAction } from '@/lib/contracts';
import { dollars } from '@/lib/format';

// Dollars for predictions live in the member's own Polymarket account. This
// sheet opens that account (one tap: your Privy wallet signs it) and moves dollars between
// it and the Cult wallet: in arrives in about half a minute, out the same.

type Props = {
  suggestUsd?: number; walletUsd: number | null;
  onClose: () => void; onChanged: () => void;
  onSend: (actions: WalletAction[]) => Promise<string>;
  runFlow: <T>(first: T | FlowStep<T>) => Promise<T>;
};

const amountInput = (value: string) => value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');

export function PredictionFundSheet({ suggestUsd, walletUsd, onClose, onChanged, onSend, runFlow }: Props) {
  const [account, setAccount] = useState<PredictionAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<'in' | 'out'>('in');
  const [amountText, setAmountText] = useState(suggestUsd ? String(suggestUsd) : '');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const token = async () => {
    const value = await getAccessToken();
    if (!value) throw new Error('Sign in again to continue.');
    return value;
  };
  useEffect(() => {
    let active = true;
    token().then(getPredictionAccount).then(value => { if (active) { setAccount(value); setError(null); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Predictions are unavailable right now.'); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, busy]);

  const act = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label); setError(null); setDone(null);
    try { const message = await work(); if (message) setDone(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Something went wrong.'); }
    finally { setBusy(null); }
  };

  // After a move: watch the balance until it changes (bridge time), up to ~3 min.
  const watchBalance = async (from: number | null) => {
    for (let i = 0; i < 36; i++) {
      await new Promise(resolve => window.setTimeout(resolve, 5000));
      const next = await getPredictionAccount(await token()).catch(() => null);
      if (next) setAccount(next);
      if (next?.balanceUsd != null && next.balanceUsd !== from) { onChanged(); return; }
    }
    onChanged();
  };

  const setup = () => act('setup', async () => {
    const opened = await runFlow(await setupPredictions(await token()));
    setAccount(opened);
    onChanged();
    return 'Predictions are on.';
  });
  const amount = Number(amountText);
  const balance = account?.balanceUsd ?? 0;
  const moveIn = () => act('in', async () => {
    const plan = await fundPredictions(await token(), amount);
    await onSend(plan.actions);
    void watchBalance(account?.balanceUsd ?? null);
    return `${dollars(plan.amountUsd)} is on its way${plan.receiveUsd != null ? ` (about ${dollars(plan.receiveUsd)} after the transfer)` : ''}. It lands in ${plan.seconds ? `about ${plan.seconds}s` : 'a minute or so'}.`;
  });
  const moveOut = () => act('out', async () => {
    const result = await runFlow(await withdrawPredictions(await token(), amount));
    void watchBalance(account?.balanceUsd ?? null);
    onChanged();
    return `${dollars(result.amountUsd)} is heading back to your wallet. It lands in about ${result.seconds}s.`;
  });
  const min = account?.funding?.minUsd ?? 2;
  const problem = !amountText ? null : !(amount >= min) ? `The smallest move is ${dollars(min)}.`
    : mode === 'in' && walletUsd != null && amount > walletUsd + 1e-6 ? `You have ${dollars(walletUsd)} in your wallet.`
    : mode === 'out' && amount > balance + 1e-6 ? `You have ${dollars(balance)} in predictions.` : null;

  return <div className="modal-backdrop deposit-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="deposit-sheet" role="dialog" aria-modal="true" aria-label="Predictions balance">
      <div className="trade-sheet-head"><span className="eyebrow">PREDICTIONS</span><button className="icon-btn" title="Close" disabled={!!busy} onClick={onClose}><X size={18} /></button></div>
      <h2>Predictions balance</h2>

      {!account ? (error ? <><p className="notice-line">{error}</p><button className="btn btn-ghost" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} /> Retry</button></> : <p className="field-note">Loading…</p>)
        : account.step === 'unavailable' ? <p className="notice-line">{account.reason ?? 'Predictions are not available yet.'}</p>
        : account.access?.predictions === 'blocked' ? <p className="notice-line">Polymarket doesn’t allow trading from your location.</p>
        : account.step === 'needs_setup' ? <>
          <p className="field-note">Bets are placed on Polymarket from your own account there, which only your wallet controls. Setting it up is one tap. Cult can place bets for you but can never withdraw.</p>
          {error && <p className="notice-line" role="status">{error}</p>}
          <button className="btn btn-primary btn-lg btn-block" disabled={!!busy} onClick={() => void setup()}>{busy === 'setup' ? 'Setting up…' : 'Set up predictions'}</button>
        </> : <>
          <div className="withdraw-review">
            <div><span>In predictions</span><strong>{dollars(account.balanceUsd)}</strong></div>
            <div><span>In your wallet</span><strong>{dollars(walletUsd)}</strong></div>
          </div>
          {account.access?.predictions === 'close_only' && <p className="field-note">Polymarket only lets you close bets from your location. You can still sell and move money back.</p>}
          {!account.funding ? <p className="field-note">Moving dollars to predictions works on Monad mainnet.</p> : <>
            <div className="seg seg--sm" role="tablist">
              <button role="tab" aria-selected={mode === 'in'} className={mode === 'in' ? 'on' : ''} onClick={() => { setMode('in'); setDone(null); }}>Add</button>
              <button role="tab" aria-selected={mode === 'out'} className={mode === 'out' ? 'on' : ''} onClick={() => { setMode('out'); setDone(null); }}>Move back</button>
            </div>
            <div className="field">
              <div className="field-top"><span className="field-label">Amount</span><small>{mode === 'in' ? 'From your wallet' : 'To your wallet'}</small></div>
              <label className="ticket-input"><span className="ticket-prefix">$</span><input inputMode="decimal" placeholder="0" value={amountText} aria-label="Amount in dollars" onChange={event => setAmountText(amountInput(event.target.value))} />
                <button type="button" className="ticket-unit" onClick={() => setAmountText(String(Math.floor(((mode === 'in' ? walletUsd : balance) ?? 0) * 100) / 100))}>Max</button></label>
              {problem ? <small className="withdraw-error">{problem}</small> : <small className="withdraw-hint">{mode === 'in' ? 'Arrives in about 30 seconds. A small transfer cost applies.' : 'Back in your wallet in about 30 seconds.'}</small>}
            </div>
            {error && <p className="notice-line" role="status">{error}</p>}
            {done && <p className="field-note"><Check size={14} /> {done}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={!!busy || !amountText || !!problem} onClick={() => void (mode === 'in' ? moveIn() : moveOut())}>
              {busy === 'in' ? 'Sending…' : busy === 'out' ? 'Moving…' : mode === 'in' ? `Add ${amount > 0 ? dollars(amount) : ''} to predictions` : `Move ${amount > 0 ? dollars(amount) : ''} back`}
            </button>
          </>}
        </>}
    </section>
  </div>;
}
