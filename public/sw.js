// Minimal service worker: makes Friday installable and shows push notifications later.
// It deliberately caches nothing: every response may contain private data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('push', (event) => {
  let d = {}; try { d = event.data.json(); } catch {}
  event.waitUntil(self.registration.showNotification(d.title || 'Friday', { body: d.body || '', icon: '/assets/icon-192.png', tag: d.tag || 'friday' }));
});
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(self.clients.openWindow('/')); });
