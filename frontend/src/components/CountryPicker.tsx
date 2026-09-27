'use client';

import { useEffect, useMemo, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { setCountry } from '@/lib/api';

type Props = { currentCode?: string | null; onSaved: () => Promise<unknown>; onSkip?: () => void };

export function CountryPicker({ currentCode, onSaved, onSkip }: Props) {
  const [code, setCode] = useState(currentCode ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const result: { code: string; name: string }[] = [];
    for (let first = 65; first <= 90; first++) for (let second = 65; second <= 90; second++) {
      const countryCode = String.fromCharCode(first, second);
      const name = names.of(countryCode);
      if (name && name !== countryCode && !name.startsWith('Unknown Region')) result.push({ code: countryCode, name });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  useEffect(() => {
    if (currentCode) { setCode(currentCode); return; }
    let active = true;
    fetch('/api/geo').then(response => response.json()).then((result: { country: string | null }) => {
      if (active && result.country && countries.some(item => item.code === result.country)) setCode(result.country);
    }).catch(() => {});
    return () => { active = false; };
  }, [currentCode, countries]);

  const save = async () => {
    if (!code || saving) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to set your country.');
      await setCountry(token, code);
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Country could not be saved.');
    } finally { setSaving(false); }
  };

  return <div className="country-picker">
    <h2>{currentCode ? 'Your country' : 'Where are you trading from?'}</h2>
    <label className="field-label" htmlFor={onSkip ? 'first-country' : 'settings-country'}>COUNTRY</label>
    <select id={onSkip ? 'first-country' : 'settings-country'} value={code} onChange={event => setCode(event.target.value)}>
      <option value="">Choose a country</option>
      {countries.map(country => <option key={country.code} value={country.code}>{country.name} ({country.code})</option>)}
    </select>
    <div className="country-actions"><button className="primary" disabled={!code || saving || code === currentCode} onClick={save}>{saving ? 'Saving…' : currentCode ? 'Change country' : 'Continue'}</button>{onSkip && <button className="outline" onClick={onSkip}>Not now</button>}</div>
    {error && <p className="wallet-warning" role="status">{error}</p>}
  </div>;
}
