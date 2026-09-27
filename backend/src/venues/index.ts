import { nadfun } from './nadfun.js';
import { perpl } from './perpl.js';
import type { Venue, VenueAdapter } from './types.js';

export * from './types.js';

const adapters: Record<Venue, VenueAdapter> = { perpl, nadfun };

export function venue(v: Venue): VenueAdapter {
  return adapters[v];
}
