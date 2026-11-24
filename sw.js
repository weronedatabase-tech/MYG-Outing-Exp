const CACHE_NAME = 'myg-pwa-cache-v17';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './volunteer.html',
  './tracker.html',
  './admin.html',
  './pairing.html',
  './grouping.html',
  './settings.html',
  './frontend/css/style.css',
  './backend/config.js',
  './frontend/js/state.js',
  './frontend/js/api.js',
  './frontend/js/ui.js',
  './frontend/js/auth.js',
  './frontend/js/dnd.js',
  './frontend/js/volunteer.js',
  './frontend/js/comm.js',
  './frontend/js/pairing.js',
  './frontend/js/grouping.js',
  './frontend/js/settings.js',
  './frontend/js/main.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('script.google.com') || event.request.url.includes('/api/')) return;

  // Network-First Strategy with Cache Fallback so collaborative clients always get latest code & UI
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});