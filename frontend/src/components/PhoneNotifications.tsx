'use client';

import { useEffect, useState } from 'react';
import { disablePhonePush, phonePushOwner, phonePushSupported, preparePhonePush, subscribePhonePush } from '@/lib/phonePush';
import { setNotifyPref } from '@/lib/prefs';
import { isDemo } from '@/lib/demo';
import { Bell } from './icons';
import { getAccessToken } from '@/lib/auth';
import { testPhonePush } from '@/lib/api';

export function PhoneNotifications({ owner }: { owner: string }) {
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof preparePhonePush>> | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('Liquidations and new trades posted to your cults, even when Cult is closed.');
  useEffect(() => {
    if (isDemo()) { setNote('Phone alerts are available on your live account.'); return; }
    if (!phonePushSupported()) { setNote('On iPhone, add Cult to your Home Screen and open it there. Use a browser that supports push notifications.'); return; }
    let active = true;
    preparePhonePush().then(async value => {
      const subscription = await value.registration.pushManager.getSubscription();
      if (active) { setPrepared(value); setEnabled(!!subscription && phonePushOwner() === owner); }
    }).catch(() => { if (active) setNote('Phone alerts could not be prepared. Reload to try again.'); });
    return () => { active = false; };
  }, [owner]);
  const toggle = async () => {
    if (busy || !prepared) return;
    setBusy(true);
    try {
      if (enabled) { await disablePhonePush(); setEnabled(false); setNote('Phone alerts are off on this device.'); }
      else { await subscribePhonePush(owner, prepared); setNotifyPref(owner, true); setEnabled(true); setNote('On for this device: liquidations and new cult trades.'); }
    } catch (error) { if (phonePushOwner() !== owner) setEnabled(false); setNote(error instanceof Error ? error.message : 'Could not update phone alerts.'); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to send a test alert.');
      await testPhonePush(token);
      setNote('Test alert queued. Check your phone notifications.');
    } catch (error) { setNote(error instanceof Error ? error.message : 'Test alert could not be sent.'); }
    finally { setBusy(false); }
  };
  return <div className="setting"><div><strong>Phone alerts</strong><small role="status">{note}</small></div>
    <button type="button" className={`btn ${enabled ? 'btn-ghost' : 'btn-primary'} btn-sm`} disabled={!prepared || busy} onClick={() => void toggle()}><Bell size={14} />{busy ? 'Updating...' : enabled ? 'Turn off' : 'Enable phone alerts'}</button>
    {enabled && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void test()}>Send test alert</button>}
  </div>;
}
