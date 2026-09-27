/* Home Game Hold'em — service worker
 * Shows "your turn" alerts while the app is closed or the phone is locked,
 * and brings the app back to the front when the alert is tapped.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || "Home Game Hold'em";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || 'turn',        // a newer alert replaces the older one instead of stacking
    renotify: true,              // ...but still buzzes and sounds again
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) return w.focus(); }
    return self.clients.openWindow('/');
  })());
});
