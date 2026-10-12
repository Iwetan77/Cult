import type { Me } from './contracts';
import { friendlyError } from './friendlyError';

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
    if (value.errorCode === 'retrying' || value.errorCode === 'capped') return null;
    if (value.status === 'cancelled' && (value.errorCode === 'exits_off' || value.error === 'member turned off Follow exits')) return null;
    return { id: value.id, clanId, reason: friendlyError({ code: value.errorCode, message: value.error }, 'Your copy did not run. Check your balance and trading permissions.') };
  } catch { return null; }
}
