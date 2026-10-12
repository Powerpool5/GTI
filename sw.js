/* GTI service worker.
   Scope is deliberately small: it keeps just enough of the site on the device
   for offline.html (the offline timetable view) to open with no connection.
   It never stores API responses, login data or student records — the cached
   timetable itself lives in localStorage (see timetable-cache.js) and is wiped
   on sign-out. Bump VERSION when the SHELL list changes. */
const VERSION = 'gti-shell-v1';

const SHELL = [
  'offline.html',
  'offline.js',
  'timetable-cache.js',
  'timetable-editor.js?v=6',
  'styles.css?v=15',
  'theme.js',
  'gti.png',
  'icon-192.png',
];

const OFFLINE_URL = new URL('offline.html', self.registration.scope).href;
const SHELL_PATHS = new Set(SHELL.map((u) => new URL(u, self.registration.scope).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
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
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase, CDNs, fonts: browser handles them
  if (request.headers.has('range')) return;

  event.respondWith(handle(request, url));
});

async function handle(request, url) {
  try {
    const response = await fetch(request);
    if (response.ok && SHELL_PATHS.has(url.pathname)) {
      const copy = response.clone();
      caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    throw err;
  }
}