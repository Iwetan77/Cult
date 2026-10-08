'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { getAccessToken } from '@/lib/auth';
import { setUsername, usernameAvailability } from '@/lib/api';
import { USERNAME_CHANGE_MONTHS, USERNAME_HINT, USERNAME_PATTERN, longDate, nextUsernameChange } from '@/lib/username';

// Settings > Username. After the first pick it can be changed once every
// USERNAME_CHANGE_MONTHS (the backend holds to it too): saving asks first,
// with a warning, and until the wait is over the field says when it opens.
export function UsernameSetting({ current, changedAt, onSaved }: { current: string; changedAt?: string | null; onSaved: () => Promise<unknown> }) {
  const [draft, setDraft] = useState(current);
  const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState(changedAt ?? null);
  const name = draft.trim();
  const changed = name !== current;
  const valid = USERNAME_PATTERN.test(name);
  const lockedUntil = nextUsernameChange(lastChange);
  const nextIfSaved = (() => { const d = new Date(); d.setMonth(d.getMonth() + USERNAME_CHANGE_MONTHS); return d; })();

  useEffect(() => { setDraft(current); setConfirming(false); }, [current]);
  useEffect(() => { setLastChange(changedAt ?? null); }, [changedAt]);
  useEffect(() => {
    setAvailable(false);
    setChecking(false);
    setConfirming(false);
    setNote(null);
    if (!changed) return;
    if (!valid) { setNote(USERNAME_HINT); return; }
    if (name.toLowerCase() === current.toLowerCase()) { setAvailable(true); return; }
    let active = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      usernameAvailability(name).then(result => {
        if (!active) return;
        setAvailable(result.available);
        setNote(result.available ? 'Available' : result.reason ?? 'That username is taken.');
      }).catch(() => { if (active) setNote('Could not check availability. Try again.'); })
        .finally(() => { if (active) setChecking(false); });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [name, current, changed, valid]);

  const ready = valid && changed && available && !checking && !saving && !lockedUntil;
  const save = async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to change your username.');
      await setUsername(token, name);
      setLastChange(new Date().toISOString());
      setConfirming(false);
      await onSaved();
      setNote('Username updated.');
    } catch (error) { setNote(error instanceof Error ? error.message : 'Could not save your username.'); setConfirming(false); }
    finally { setSaving(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (ready) setConfirming(true);
  };

  return <form className="setting setting--username" onSubmit={submit}>
    <div><label htmlFor="account-username"><strong>Username</strong></label>
      <small>{lockedUntil ? `You changed it recently. You can change it again on ${longDate(lockedUntil)}.` : `Your name next to trades and messages. You can change it once every ${USERNAME_CHANGE_MONTHS} months.`}</small></div>
    <div className="username-edit"><input id="account-username" value={draft} onChange={event => setDraft(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={20} disabled={saving || !!lockedUntil} />
      {!confirming && <button className="btn btn-primary btn-sm" type="submit" disabled={!ready}>Save</button>}
      {confirming ? <div className="username-confirm" role="alertdialog" aria-label="Confirm username change">
        <p><strong>Change your username to @{name}?</strong> You won&apos;t be able to change it again until {longDate(nextIfSaved)}. Your old name, @{current}, may be taken by someone else.</p>
        <div className="row-gap"><button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Change username'}</button></div>
      </div> : <small role="status">{checking ? 'Checking availability...' : note}</small>}
    </div>
  </form>;
}
