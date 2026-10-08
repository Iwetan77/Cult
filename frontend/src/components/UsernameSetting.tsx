'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { getAccessToken } from '@/lib/auth';
import { setUsername, usernameAvailability } from '@/lib/api';

export function UsernameSetting({ current, onSaved }: { current: string; onSaved: () => Promise<unknown> }) {
  const [draft, setDraft] = useState(current);
  const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const name = draft.trim();
  const changed = name !== current;
  const valid = /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(name);

  useEffect(() => { setDraft(current); }, [current]);
  useEffect(() => {
    setAvailable(false);
    setChecking(false);
    setNote(null);
    if (!changed) return;
    if (!valid) { setNote('Use 3-20 letters, numbers or underscores. Start with a letter.'); return; }
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

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || !changed || !available || checking || saving) return;
    setSaving(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to change your username.');
      await setUsername(token, name);
      await onSaved();
      setNote('Username updated.');
    } catch (error) { setNote(error instanceof Error ? error.message : 'Could not save your username.'); }
    finally { setSaving(false); }
  };

  return <form className="setting setting--username" onSubmit={save}>
    <div><label htmlFor="account-username"><strong>Username</strong></label><small>Your name next to trades and messages.</small></div>
    <div className="username-edit"><input id="account-username" value={draft} onChange={event => setDraft(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={20} disabled={saving} />
      <button className="btn btn-primary btn-sm" type="submit" disabled={!changed || !available || checking || saving}>{saving ? 'Saving...' : 'Save'}</button>
      <small role="status">{checking ? 'Checking availability...' : note}</small>
    </div>
  </form>;
}
