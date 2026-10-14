// Offline shell: every file of this release is cached at install, so the
// wallet opens (and the recovery phrase can be revealed) without a
// connection and without the CPAY website. Payments still need the
// Lightning/Spark network.
//
// build.mjs replaces __PRECACHE__ with this release's file list and
// __VERSION__ with its version; a new release installs as a new cache and
// the old one is deleted on activate.
const VERSION = '__VERSION__';
const FILES = __PRECACHE__;
const CACHE = `cpay-wallet-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cpay-wallet-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Same-origin GETs only: the wallet's own files. Network requests to the
// Lightning/Spark services and the optional CPAY link are never cached.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
