// The app's pages as URLs, so the browser's back button walks through Cult
// instead of leaving it, and any page can be linked or refreshed.
//
//   /                      Home
//   /markets               Markets
//   /markets/:id           a market (perp id or token address) and its cult chart
//   /predictions/:slug     a prediction market
//   /discover              public cults
//   /leaderboard           rankings
//   /cults                 your cults (phones)
//   /cults/:id             a cult's room
//   /rooms/global          the global room
//   /rooms/:cc             a country room (two-letter code)
//   /trades                your open trades
//   /trades/closed         your closed trades
//   /settings              your settings
//   /u/:id, /u/:id/closed  someone's profile
//
// Shared by the server page (which 404s anything else) and the dashboard.

export type AccountTab = 'open' | 'closed' | 'settings';
export type View = 'home' | 'chat' | 'discover' | 'account' | 'leaderboards' | 'markets' | 'groups';

export type Route = {
  view: View;
  // Markets: the open market's id, or "pm:<slug>" for a prediction.
  market: string | null;
  // Chat: "global", "country:NG" or "cult:<id>".
  room: string | null;
  // Account: "me" or a member id, and the tab.
  profile: string;
  tab: AccountTab;
};

const base: Route = { view: 'home', market: null, room: null, profile: 'me', tab: 'open' };

// First path segments the app answers to.
export const APP_SECTIONS = new Set(['markets', 'predictions', 'discover', 'leaderboard', 'cults', 'rooms', 'trades', 'settings', 'account', 'u']);

const decode = (part: string | undefined) => {
  if (!part) return null;
  try { return decodeURIComponent(part); } catch { return null; }
};

export function parseRoute(pathname: string): Route | null {
  const parts = pathname.split('/').filter(Boolean);
  const [first, second, third] = parts;
  const one = decode(second);
  if (!first) return base;
  switch (first) {
    case 'markets': return parts.length <= 2 ? { ...base, view: 'markets', market: one } : null;
    case 'predictions': return parts.length === 2 && one ? { ...base, view: 'markets', market: `pm:${one}` } : null;
    case 'discover': return parts.length === 1 ? { ...base, view: 'discover' } : null;
    case 'leaderboard': return parts.length === 1 ? { ...base, view: 'leaderboards' } : null;
    case 'cults': return parts.length === 1 ? { ...base, view: 'groups' } : parts.length === 2 && one ? { ...base, view: 'chat', room: `cult:${one}` } : null;
    case 'rooms':
      if (parts.length !== 2 || !one) return null;
      if (one === 'global') return { ...base, view: 'chat', room: 'global' };
      return /^[a-z]{2}$/i.test(one) ? { ...base, view: 'chat', room: `country:${one.toUpperCase()}` } : null;
    case 'trades': case 'account':
      if (parts.length === 1) return { ...base, view: 'account' };
      return parts.length === 2 && second === 'closed' ? { ...base, view: 'account', tab: 'closed' } : null;
    case 'settings': return parts.length === 1 ? { ...base, view: 'account', tab: 'settings' } : null;
    case 'u':
      if (!one || parts.length > 3 || (third && third !== 'closed')) return null;
      return { ...base, view: 'account', profile: one, tab: third ? 'closed' : 'open' };
    default: return null;
  }
}

const enc = encodeURIComponent;

export function routePath(route: Partial<Route> & { view: View }): string {
  switch (route.view) {
    case 'home': return '/';
    case 'markets':
      if (!route.market) return '/markets';
      return route.market.startsWith('pm:') ? `/predictions/${enc(route.market.slice(3))}` : `/markets/${enc(route.market)}`;
    case 'discover': return '/discover';
    case 'leaderboards': return '/leaderboard';
    case 'groups': return '/cults';
    case 'chat': {
      const room = route.room ?? 'global';
      if (room.startsWith('cult:')) return `/cults/${enc(room.slice(5))}`;
      if (room.startsWith('country:')) return `/rooms/${room.slice(8).toLowerCase()}`;
      return '/rooms/global';
    }
    case 'account': {
      const tab = route.tab ?? 'open';
      if (route.profile && route.profile !== 'me') return `/u/${enc(route.profile)}${tab === 'closed' ? '/closed' : ''}`;
      return tab === 'settings' ? '/settings' : tab === 'closed' ? '/trades/closed' : '/trades';
    }
  }
}
