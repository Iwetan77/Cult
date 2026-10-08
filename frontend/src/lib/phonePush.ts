import { getAccessToken } from './auth';
import { deletePushSubscription, getPushConfig, savePushSubscription } from './api';

const OWNER_KEY = 'cult:push-owner';
export const phonePushSupported = () => typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export function phonePushOwner(): string | null {
  try { return localStorage.getItem(OWNER_KEY); } catch { return null; }
}
const storeOwner = (owner: string | null) => { try { if (owner) localStorage.setItem(OWNER_KEY, owner); else localStorage.removeItem(OWNER_KEY); } catch { /* Storage is optional. */ } };

export async function preparePhonePush() {
  if (!phonePushSupported()) throw new Error('On iPhone, add Cult to your Home Screen and open it there to enable phone alerts.');
  const token = await getAccessToken();
  if (!token) throw new Error('Sign in again to enable phone alerts.');
  const config = await getPushConfig(token);
  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const serverKey = existing?.options.applicationServerKey;
  if (serverKey) {
    const encoded = btoa(String.fromCharCode(...new Uint8Array(serverKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (encoded !== config.publicKey) { await existing.unsubscribe(); storeOwner(null); }
  }
  return { registration, publicKey: config.publicKey };
}

export async function subscribePhonePush(owner: string, prepared: Awaited<ReturnType<typeof preparePhonePush>>) {
  // Keep this permission request before any await: phones require a user gesture.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Allow notifications in your browser or phone settings to receive alerts.');
  const raw = atob(prepared.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
  const key = new Uint8Array(Array.from(raw, char => char.charCodeAt(0)));
  const existing = await prepared.registration.pushManager.getSubscription();
  const subscription = existing ?? await prepared.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const token = await getAccessToken();
  if (!token) throw new Error('Sign in again to enable phone alerts.');
  try { await savePushSubscription(token, subscription.toJSON()); }
  catch (error) { if (!existing) await subscription.unsubscribe(); throw error; }
  storeOwner(owner);
}

export async function disablePhonePush() {
  if (!phonePushSupported()) { storeOwner(null); return; }
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) { storeOwner(null); return; }
  try {
    const token = await getAccessToken();
    if (token) await deletePushSubscription(token, subscription.endpoint);
  } finally { await subscription.unsubscribe(); storeOwner(null); }
}
