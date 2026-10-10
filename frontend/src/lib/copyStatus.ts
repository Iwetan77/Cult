import type { Me } from './contracts';

export function perpsCopyReady(perpl: Me['perpl'] | undefined): boolean {
  return !!perpl?.accountId && perpl.keyEnrolled && perpl.forwarding;
}

export type CopyFailure = { id: string; clanId: string; reason: string };

export function copyFailureFromEvent(data: string, memberId: string | undefined, clanId: string): CopyFailure | null {
  if (!memberId) return null;
  try {
    const value = JSON.parse(data);
    if (!value || value.userId !== memberId || value.clanId !== clanId || typeof value.id !== 'string') return null;
    if (value.status !== 'failed' && value.status !== 'cancelled') return null;
    if (value.status === 'cancelled' && value.error === 'member turned off Follow exits') return null;
    return { id: value.id, clanId, reason: typeof value.error === 'string' && value.error.trim() ? value.error : 'This copy did not run. Check your funding and trading permissions.' };
  } catch { return null; }
}
