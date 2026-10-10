import type { BackendConfig, MirrorPolicy } from './contracts';

export function autoFollowDraft(policy: MirrorPolicy | null | undefined, defaults: BackendConfig['autoFollowDefaults'] | undefined) {
  const limits = policy ?? defaults ?? { maxUsdPerTrade: 100, balancePercentCap: 10 };
  return { maxUsd: String(limits.maxUsdPerTrade), balancePct: String(limits.balancePercentCap) };
}

export function validateMirrorPolicy(policy: MirrorPolicy): void {
  if (!Number.isFinite(policy.maxUsdPerTrade) || policy.maxUsdPerTrade < 1 || policy.maxUsdPerTrade > 1_000_000) {
    throw new Error('Enter a maximum copy value from $1 to $1,000,000.');
  }
  if (!Number.isFinite(policy.balancePercentCap) || policy.balancePercentCap <= 0 || policy.balancePercentCap > 100) {
    throw new Error('Enter a free balance cap above 0% and up to 100%.');
  }
}

export function mirrorPolicyFromDraft(maxUsd: string, balancePct: string, followExits?: boolean): MirrorPolicy {
  const policy = { enabled: true, maxUsdPerTrade: Number(maxUsd), balancePercentCap: Number(balancePct), ...(followExits == null ? {} : { followExits }) };
  validateMirrorPolicy(policy);
  return policy;
}
