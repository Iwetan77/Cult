'use client';

import { useCallback, useEffect, useState } from 'react';
import { Delete } from './icons';

// Four dots and a number pad. Typing works too. When the fourth digit is in,
// onComplete gets the PIN; the pad clears when it's done (right or wrong).

type Props = {
  title: string;
  note?: string;
  error?: string | null;
  busy?: boolean;
  onComplete: (pin: string) => Promise<unknown> | void;
};

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'] as const;

// 0000, 1234, 9876 and the like (the backend refuses them too).
export const weakPin = (pin: string) => {
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]!);
  return steps.every(s => s === 0) || steps.every(s => s === 1) || steps.every(s => s === -1);
};

export function PinPad({ title, note, error, busy = false, onComplete }: Props) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(0);
  useEffect(() => { if (error) setShake(n => n + 1); }, [error]);

  const press = useCallback((key: string) => {
    if (busy) return;
    if (key === 'back') { setPin(p => p.slice(0, -1)); return; }
    if (pin.length >= 4) return;
    const next = pin + key;
    setPin(next);
    if (next.length === 4) void Promise.resolve(onComplete(next)).finally(() => setPin(''));
  }, [busy, pin, onComplete]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]')) return;
      if (/^\d$/.test(event.key)) { event.preventDefault(); press(event.key); }
      else if (event.key === 'Backspace') { event.preventDefault(); press('back'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  return <div className="pinpad">
    <strong className="pinpad-title">{title}</strong>
    {note && <p className="pinpad-note">{note}</p>}
    <div key={shake} className={`pinpad-dots${error ? ' is-error' : ''}`} role="img" aria-label={`${pin.length} of 4 digits entered`}>
      {[0, 1, 2, 3].map(i => <i key={i} className={i < pin.length ? 'on' : ''} />)}
    </div>
    <p className="pinpad-error" role="alert" aria-live="assertive">{busy ? 'Checking…' : error ?? ''}</p>
    <div className="pinpad-keys">
      {KEYS.map((key, i) => key === '' ? <span key={i} />
        : <button key={i} type="button" className="pinpad-key" disabled={busy} aria-label={key === 'back' ? 'Delete' : key} onClick={() => press(key)}>
          {key === 'back' ? <Delete size={20} /> : key}
        </button>)}
    </div>
  </div>;
}
