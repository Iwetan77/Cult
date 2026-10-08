// Usernames: the same rule as the backend (api/names.ts), and how often one
// may be changed after the first pick.

export const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;
export const USERNAME_HINT = 'Use 3–20 letters, numbers or underscores. Start with a letter.';
export const USERNAME_CHANGE_MONTHS = 3;

// When the next change is allowed, given the last one (null: allowed now).
export function nextUsernameChange(lastChangedAt: string | null | undefined): Date | null {
  const last = lastChangedAt ? new Date(lastChangedAt) : null;
  if (!last || Number.isNaN(last.getTime())) return null;
  const next = new Date(last);
  next.setMonth(next.getMonth() + USERNAME_CHANGE_MONTHS);
  return next.getTime() > Date.now() ? next : null;
}

export const longDate = (date: Date) => date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
