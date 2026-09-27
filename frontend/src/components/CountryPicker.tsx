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
    for (const countryCode of 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')) {
      const name = names.of(countryCode);
      if (name) result.push({ code: countryCode, name });
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
