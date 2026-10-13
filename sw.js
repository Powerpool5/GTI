/* GTI service worker.
   Job 1: when the device is offline, open offline.html (the locked offline
   view with the saved timetable) instead of a browser error.
   Job 2: keep the site's own scripts, styles and images on the device, so a
   flaky connection (Wi-Fi dropping or coming back mid-load) can't leave a page
   half-loaded and unstyled. Files are always fetched fresh when the network
   works; the saved copy is only used when it doesn't.
   It never stores API responses, login data or student records — the saved
   timetable itself lives in localStorage (see timetable-cache.js) and is wiped
   on sign-out. Bump VERSION when this file or the SHELL list changes. */
const VERSION = 'gti-shell-v6';

const SHELL = [
  'offline.html',
  'timetable-cache.js',
  'timetable-editor.js?v=6',
  'styles.css?v=15',
  'theme.js',
  'pwa.js?v=2',
  'app.js?v=7',
  'gti.png',
  'icon-192.png',
];

const SCOPE = self.registration.scope;
const OFFLINE_URL = new URL('offline.html', SCOPE).href;
const ASSET_RE = /\.(?:css|js|png|jpe?g|gif|webp|svg|ico|webmanifest)$/i;
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const SLOW_NETWORK_MS = 6000;

function keyFor(url) {
  const u = new URL(url, SCOPE);
  return u.origin + u.pathname;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const store = async (path) => {
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (!response.ok) throw new Error(path + ' ' + response.status);
      await cache.put(keyFor(path), response);
    };
    await store(SHELL[0]);
    await Promise.allSettled(SHELL.slice(1).map(store));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') event.respondWith(handleNavigation(request));
    else if (ASSET_RE.test(url.pathname)) event.respondWith(handleAsset(request, keyFor(request.url)));
  } else if (request.url === SUPABASE_CDN) {
    event.respondWith(handleAsset(request, SUPABASE_CDN));
  }
});

let lastShellRefresh = 0;
const OFFLINE_ONLY = ['offline.html'];
function refreshOfflineFiles() {
  const now = Date.now();
  if (now - lastShellRefresh < 10 * 60 * 1000) return;
  lastShellRefresh = now;
  OFFLINE_ONLY.forEach((path) => {
    fetch(new URL(path, SCOPE).href, { cache: 'no-cache' })
      .then((response) => response.ok ? caches.open(VERSION).then((cache) => cache.put(keyFor(path), response)) : null)
      .catch(() => {});
  });
}

async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    refreshOfflineFiles();
    return response;
  } catch (err) {
    const cache = await caches.open(VERSION);
    const direct = await cache.match(keyFor(request.url));
    if (direct) return direct;
    const offline = await cache.match(keyFor(OFFLINE_URL));
    if (offline) return offline;
    throw err;
  }
}

async function handleAsset(request, key) {
  const cache = await caches.open(VERSION);
  const cached = cache.match(key);

  const network = fetch(request, key === SUPABASE_CDN ? undefined : { cache: 'no-cache' })
    .then((response) => {
      if (response.ok || response.type === 'opaque') cache.put(key, response.clone()).catch(() => {});
      return response;
    });

  const slow = new Promise((resolve) => setTimeout(() => resolve(null), SLOW_NETWORK_MS));
  const first = await Promise.race([network.catch(() => null), slow]);
  if (first) return first;

  const saved = await cached;
  if (saved) return saved;
  return network;
}