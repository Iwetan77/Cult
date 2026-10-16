// Which Cult backend this device talks to: testnet or mainnet. Each network is
// its own backend (its own database, Perpl, chain), so switching reloads the
// app against the other one. The choice is remembered per device.
//
// NEXT_PUBLIC_CULT_API_BASE_URL is the testnet backend (the default), and
// NEXT_PUBLIC_CULT_API_BASE_URL_MAINNET the mainnet one. Without the mainnet
// URL there's nothing to switch to and the app stays on testnet.
// NEXT_PUBLIC_DEFAULT_NETWORK=mainnet makes mainnet the default for new devices.

export type Network = 'testnet' | 'mainnet';

const KEY = 'cult:network';
const URLS: Record<Network, string | undefined> = {
  testnet: process.env.NEXT_PUBLIC_CULT_API_BASE_URL,
  mainnet: process.env.NEXT_PUBLIC_CULT_API_BASE_URL_MAINNET,
};

export const CHAIN_IDS: Record<Network, number> = { testnet: 10143, mainnet: 143 };

export const mainnetAvailable = () => !!URLS.mainnet;

const defaultNetwork = (): Network =>
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK === 'mainnet' && URLS.mainnet ? 'mainnet' : 'testnet';

export function currentNetwork(): Network {
  if (typeof window === 'undefined') return defaultNetwork();
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'mainnet' && URLS.mainnet) return 'mainnet';
    if (saved === 'testnet' && URLS.testnet) return 'testnet';
  } catch { /* storage blocked: use the default */ }
  return defaultNetwork();
}

// The API base for this device's network, without a trailing slash.
export function apiBase(): string | undefined {
  return URLS[currentNetwork()]?.replace(/\/$/, '');
}

// Switch and reload, so every screen, cache and live stream starts over
// against the other backend.
export function switchNetwork(next: Network) {
  if (next === currentNetwork()) return;
  try { window.localStorage.setItem(KEY, next); } catch { /* best effort */ }
  window.location.reload();
}
