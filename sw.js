/*
 * sw.js - Service worker for the Tasks PWA.
 *
 * Caches the static app shell so the app loads instantly and works offline.
 * CalDAV traffic (cross-origin, and non-GET) is never intercepted — those
 * requests fall through to the network so live sync behaves normally.
 *
 * Bump CACHE_VERSION whenever the app shell changes to roll the cache.
 */
const CACHE_VERSION = 'v4';
const CACHE_NAME = 'tasklist-' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/ical.js',
  './js/caldav.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests (the app shell). Let everything
  // else — notably CalDAV requests to the calendar server — pass straight
  // through to the network untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(staleWhileRevalidate(req));
});

// Serve from cache immediately, refresh the cache entry in the background.
function staleWhileRevalidate(req) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(req).then((cached) => {
      const network = fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            cache.put(req, resp.clone());
          }
          return resp;
        })
        .catch(() => cached); // offline: fall back to whatever we have
      return cached || network;
    })
  );
}
