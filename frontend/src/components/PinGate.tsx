'use client';

import { useState } from 'react';
import { PinPad, weakPin } from './PinPad';

// Right after signing in: everyone sets a 4-digit PIN (members who signed up
// before PINs existed see this on their next visit). It's asked again before
// money leaves Cult. "reset" is the same screen after "Forgot PIN" and a
// fresh sign-in.

type Props = { mode: 'set' | 'reset'; onSave: (pin: string) => Promise<void>; onSignOut: () => void; onCancel?: () => void };

export function PinGate({ mode, onSave, onSignOut, onCancel }: Props) {
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const enter = async (pin: string) => {
    if (!first) {
      if (weakPin(pin)) { setError('Too easy to guess. Pick another.'); return; }
      setError(null); setFirst(pin);
      return;
    }
    if (pin !== first) { setFirst(null); setError('Those didn’t match. Start again.'); return; }
    setSaving(true); setError(null);
    try { await onSave(pin); }
    catch (reason) { setFirst(null); setError(reason instanceof Error ? reason.message : 'Your PIN could not be saved.'); }
    finally { setSaving(false); }
  };

  return <main className="username-screen">
    <img className="login-brand" src="/landing/cult-logo.svg" alt="Cult" width={65} height={34} />
    <section className="username-form pin-form">
      <span className="eyebrow">{mode === 'reset' ? 'NEW PIN' : 'KEEP YOUR MONEY SAFE'}</span>
      <h1>{first ? 'Confirm your PIN' : mode === 'reset' ? 'Set a new PIN' : 'Set your PIN'}</h1>
      <PinPad key={first ? 'confirm' : 'first'} title={first ? 'Enter it once more' : 'Choose 4 digits'}
        note={first ? undefined : 'You’ll enter it before money leaves Cult. Trades stay one tap.'}
        error={error} busy={saving} onComplete={enter} />
      <button type="button" className="link pin-signout" onClick={onCancel ?? onSignOut}>{onCancel ? 'I remember my PIN' : 'Sign out'}</button>
    </section>
  </main>;
}
