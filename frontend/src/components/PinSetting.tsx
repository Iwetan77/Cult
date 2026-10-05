'use client';

import { useState } from 'react';
import { getAccessToken } from '@/lib/auth';
import { setPin } from '@/lib/api';
import { PIN_RESET_KEY } from '@/lib/session';
import { PinPad, weakPin } from './PinPad';

// Settings > PIN: change it (current one first), or, if it's forgotten, sign
// in again and set a new one (the backend only resets right after a sign-in).

type Step = 'current' | 'new' | 'confirm';

export function PinSetting({ onSignOut }: { onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [step, setStep] = useState<Step>('current');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const start = () => { setOpen(true); setForgot(false); setStep('current'); setCurrent(''); setNext(''); setError(null); setDone(false); };
  const enter = async (pin: string) => {
    if (step === 'current') { setCurrent(pin); setError(null); setStep('new'); return; }
    if (step === 'new') {
      if (weakPin(pin)) { setError('Too easy to guess. Pick another.'); return; }
      setNext(pin); setError(null); setStep('confirm'); return;
    }
    if (pin !== next) { setError('Those didn’t match. Enter the new PIN again.'); setStep('new'); return; }
    setBusy(true); setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to change your PIN.');
      await setPin(token, next, current);
      setOpen(false); setDone(true);
    } catch (reason) {
      // A wrong current PIN starts over from it.
      setError(reason instanceof Error ? reason.message : 'Your PIN could not be changed.');
      setStep('current');
    } finally { setBusy(false); }
  };
  const resetBySignIn = () => {
    try { window.sessionStorage.setItem(PIN_RESET_KEY, '1'); } catch { /* the gate won't know; they can still sign in */ }
    onSignOut();
  };

  return <div className="setting setting--pin">
    <div><strong>PIN</strong><small>{done ? 'Your PIN is changed.' : 'Asked before money leaves Cult.'}</small></div>
    {!open ? <button className="btn btn-ghost btn-sm" onClick={start}>Change</button>
      : <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>}
    {open && !forgot && <div className="setting-pin-body">
      <PinPad key={step} title={step === 'current' ? 'Your current PIN' : step === 'new' ? 'Your new PIN' : 'New PIN once more'}
        error={error} busy={busy} onComplete={enter} />
      {step === 'current' && <button type="button" className="link" onClick={() => setForgot(true)}>Forgot it?</button>}
    </div>}
    {open && forgot && <div className="setting-pin-body">
      <p className="field-note">Sign out, sign back in with the same account, and you can set a new PIN straight away.</p>
      <button className="btn btn-primary btn-block" onClick={resetBySignIn}>Sign out to reset my PIN</button>
      <button type="button" className="link" onClick={() => setForgot(false)}>Back</button>
    </div>}
  </div>;
}
