'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { usernameAvailability } from '@/lib/api';

export function UsernameGate({ onSave }: { onSave: (username: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(username);

  useEffect(() => {
    setAvailable(null);
    setReason(null);
    if (!username) return;
    if (!valid) { setReason('Use 3–20 letters, numbers or underscores. Start with a letter.'); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      setChecking(true);
      usernameAvailability(username).then(result => {
        if (!active) return;
        setAvailable(result.available);
        setReason(result.available ? null : result.reason ?? 'That username is taken.');
      }).catch(() => { if (active) setReason('Availability could not be checked. Try again.'); })
        .finally(() => { if (active) setChecking(false); });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [username, valid]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || !available || saving) return;
    setSaving(true); setError(null);
    try { await onSave(username); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Username could not be saved.'); }
    finally { setSaving(false); }
  };

  return <main className="username-screen"><img className="login-brand" src="/landing/cult-logo.svg" alt="Cult" width={65} height={34} /><form className="username-form" onSubmit={submit}>
    <span className="eyebrow">YOUR ACCOUNT</span><h1>Pick a username</h1>
    <label className="field-label" htmlFor="username">USERNAME</label>
    <input id="username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={20} autoFocus />
    <p className={available ? 'username-available' : 'field-note'} aria-live="polite">{checking ? 'Checking…' : available ? 'Available' : reason ?? 'This is how other traders will know you.'}</p>
    {error && <p className="notice-line" role="alert">{error}</p>}
    <button className="btn btn-primary btn-block" type="submit" disabled={!valid || !available || saving}>{saving ? 'Saving…' : 'Continue'}</button>
  </form></main>;
}
