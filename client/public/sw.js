/*
 * Service worker: shows a pushed notification and opens the app where it points.
 * Deliberately tiny. It caches nothing: this app is useless offline anyway, and a
 * stale cached shell on a collector's phone would be worse than a slow load.
 */

self.addEventListener('push', (event) => {
  let payload = { title: 'اشتراك المولد', body: '', url: '/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A push with no usable body still deserves a notification.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      dir: 'auto',
      data: { url: payload.url || '/' },
      tag: payload.tag || 'moteur',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
