// Where a member may trade on Polymarket. Polymarket requires builders to
// check the end user's location before submitting orders for them, and to
// block (not just warn) restricted places. Lists from
// https://docs.polymarket.com/api-reference/geoblock and
// .../api-reference/perps/geographic-restrictions (2026-10).
//
// Our server submits the orders, so its own IP must also be allowed: run the
// backend outside the US (Railway's EU region). See README.

// No new orders and no closing (OFAC).
const BLOCKED = new Set(['IR', 'SY', 'CU', 'KP']);
// Close-only on the API: existing positions can be sold, nothing new opened.
const CLOSE_ONLY = new Set([
  'AU', 'BY', 'BE', 'BI', 'BR', 'CF', 'CD', 'ET', 'FR', 'DE', 'IQ', 'IT', 'LB', 'LY', 'MM', 'NZ', 'NI', 'PL', 'RU', 'SG', 'SO', 'SK', 'SS',
  'SD', 'TW', 'TH', 'GB', 'US', 'UM', 'VE', 'YE', 'ZW',
  // Only some provinces are close-only, but we only know the country.
  'CA',
]);
// Polymarket Perps: no orders at all from these.
const PERPS_BLOCKED = new Set(['US', 'CA', 'CU', 'IR', 'KP', 'SY']);

export type Access = 'open' | 'close_only' | 'blocked';

export interface GeoAccess {
  country: string | null; // ISO 3166 alpha-2, null when unknown
  predictions: Access;
  perps: Access;
}

export function accessFor(country: string | null): GeoAccess {
  const c = country?.toUpperCase() ?? null;
  return {
    country: c,
    predictions: !c ? 'open' : BLOCKED.has(c) ? 'blocked' : CLOSE_ONLY.has(c) ? 'close_only' : 'open',
    perps: !c ? 'open' : PERPS_BLOCKED.has(c) ? 'blocked' : 'open',
  };
}

// Country of an IP, cached a day. Two free lookups (no key); if both fail we
// fall back to the country the member picked in the app.
const cache = new Map<string, { country: string | null; at: number }>();
const DAY = 86_400_000;

export async function countryOfIp(ip: string | null, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!ip || isPrivate(ip)) return null;
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < DAY) return hit.country;
  const lookups: Array<[string, (j: Record<string, unknown>) => unknown]> = [
    [`https://api.country.is/${encodeURIComponent(ip)}`, (j) => j.country],
    [`https://ipwho.is/${encodeURIComponent(ip)}?fields=country_code`, (j) => j.country_code],
  ];
  for (const [url, pick] of lookups) {
    try {
      const r = await fetcher(url, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const code = pick((await r.json()) as Record<string, unknown>);
      if (typeof code === 'string' && /^[A-Za-z]{2}$/.test(code)) {
        cache.set(ip, { country: code.toUpperCase(), at: Date.now() });
        return code.toUpperCase();
      }
    } catch {
      /* next lookup */
    }
  }
  return null;
}

function isPrivate(ip: string): boolean {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:)/i.test(ip) || ip === 'localhost';
}
