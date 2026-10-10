import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupPanel } from '../../src/components/GroupPanel';
import type { MirrorPolicy } from '../../src/lib/contracts';

// Isolated browser fixture. Auth, API and the unchanged chart are stubbed by
// the QA bundler; this never accesses a member account or trading venue.
function Fixture() {
  const [policy, setPolicy] = useState<MirrorPolicy>({ enabled: true, followExits: true, maxUsdPerTrade: 25, balancePercentCap: 5 });
  const nothing = () => {};
  return <div className="dash" style={{ display: 'block', width: '100%', padding: 16 }} data-exits={String(policy.followExits)} data-limit={policy.maxUsdPerTrade}>
    <GroupPanel room={{ id: 'cult:qa', kind: 'cult', name: 'Test cult', icon: 'T', memberCount: 2, lastMessage: null }}
      cult={{ id: 'qa', name: 'Test cult', inviteCode: 'ABC-DEF', visibility: 'private', isOwner: false, memberCount: 2, myPolicy: policy, autoFollow: policy.enabled }}
      config={null} snapshot={null} selected={null} busy={false} signerPrompt={null} onGrantSigner={nothing}
      perpsReady perpsFunded onEnablePerps={nothing} onDeposit={nothing} copyFailure={null} onDismissCopyFailure={nothing}
      onFollowOn={async next => setPolicy(next)} onFollowOff={async () => setPolicy(p => ({ ...p, enabled: false }))}
      onFollowExits={async followExits => setPolicy(p => ({ ...p, followExits }))}
      onMarket={nothing} onMarker={nothing} onOpenTrade={nothing} onGuideDrop={nothing} onInvite={nothing}
      onVisibility={nothing} onLeave={async () => {}} onProfile={nothing} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
