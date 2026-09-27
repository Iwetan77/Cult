'use client';

import { useEffect, useState } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { ArrowRight, RefreshCw, ShieldCheck } from 'lucide-react';
import { discoverCults } from '@/lib/api';
import type { DiscoverCult, MirrorPolicy } from '@/lib/contracts';

type Props = {
  busy: boolean;
  onJoin: (cultId: string, policy: MirrorPolicy) => void;
};

export function DiscoverCults({ busy, onJoin }: Props) {
  const [cults, setCults] = useState<DiscoverCult[]>([]);
  const [policy, setPolicy] = useState<MirrorPolicy>({ enabled: true, balancePercentCap: 10, maxUsdPerTrade: 100 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    getAccessToken().then(token => {
      if (!token) throw new Error('Sign in again to discover Cults.');
      return discoverCults(token);
    }).then(result => {
      if (active) { setCults(result.cults); setError(null); }
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : 'Discovery is unavailable.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  return <main className="full-workspace discovery">
    <div className="screen-head"><div><span className="eyebrow">PUBLIC CULTS</span><h1>Discover</h1></div><button className="icon-button" title="Refresh Cults" onClick={() => { setLoading(true); setRevision(value => value + 1); }}><RefreshCw size={17} /></button></div>
    <div className="discovery-body">
      <div className="discovery-policy">
        <div className="policy-heading"><ShieldCheck size={17} /><strong>Your mirror limits</strong></div>
        <p className="field-note">Joining needs your wallet signature and a capped trading signer. Your account stays yours.</p>
        <label className="switch-row"><span>Auto mirror</span><input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({ ...policy, enabled: event.target.checked })} /></label>
        <div className="policy-fields"><label><span className="field-label">UP TO % OF BALANCE</span><input type="number" min="1" max="100" value={policy.balancePercentCap} onChange={event => setPolicy({ ...policy, balancePercentCap: Number(event.target.value) })} /></label><label><span className="field-label">MAX $ PER TRADE</span><input type="number" min="1" value={policy.maxUsdPerTrade} onChange={event => setPolicy({ ...policy, maxUsdPerTrade: Number(event.target.value) })} /></label></div>
      </div>
      <div className="discovery-list">
        {loading ? <p className="field-note">Loading public Cults…</p> : error ? <p className="wallet-warning">{error}</p> : cults.length === 0 ? <p className="field-note">No public Cults yet.</p> : cults.map(cult => <div className="discovery-row" key={cult.id}>
          <span className="clan-avatar">{cult.name.slice(0, 1).toUpperCase()}</span>
          <div><strong>{cult.name}</strong><small>{cult.memberCount} {cult.memberCount === 1 ? 'member' : 'members'}</small></div>
          {cult.joined ? <span className="discovery-joined">Joined</span> : <button className="outline" disabled={busy} onClick={() => onJoin(cult.id, policy)}>Sign & join <ArrowRight size={14} /></button>}
        </div>)}
      </div>
    </div>
  </main>;
}
