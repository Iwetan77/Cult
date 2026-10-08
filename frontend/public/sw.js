self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data;
  try { data = event.data.json(); } catch { return; }
  if (!data || typeof data.title !== 'string') return;
  event.waitUntil(self.registration.showNotification(data.title.slice(0, 120), {
    body: typeof data.body === 'string' ? data.body.slice(0, 240) : '',
    icon: '/push-icon-192.png', badge: '/push-icon-192.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  let url = new URL('/', self.location.origin);
  try {
    const target = new URL(event.notification.data?.url || '/', self.location.origin);
    if (target.origin === self.location.origin) url = target;
  } catch { /* A malformed destination opens Home. */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      const navigated = await client.navigate(url.href);
      if (navigated) { await navigated.focus(); return; }
    }
    await self.clients.openWindow(url.href);
  })());
});
