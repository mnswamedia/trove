// Trove PWA Service Worker
const CACHE_NAME = 'trove-pwa-v10';

// Core App Shell assets to pre-cache on install
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './assets/icons/icon-16x16.png',
  './assets/icons/icon-32x32.png',
  './assets/icons/icon-48x48.png',
  './assets/icons/icon-96x96.png',
  './assets/icons/icon-180x180.png',
  './assets/icons/icon-192x192.png',
  './assets/icons/icon-192x192-maskable.png',
  './assets/icons/icon-512x512.png',
  './assets/icons/icon-512x512-maskable.png'
];

// Install: pre-cache the shell and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: purge stale caches and claim all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Strategy depending on request type
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Never cache non-GET requests
  if (req.method !== 'GET') {
    return;
  }

  // 2. CRITICAL: Bypass Service Worker completely for Audio/Video media streams and Range requests.
  // Intercepting 206 Partial Content streams breaks audio scrubbing in Safari/iOS and Chromium.
  const isMediaStream = req.headers.has('range') || 
    url.pathname.match(/\.(m4a|mp3|flac|wav|ogg|opus|aac|mp4|webm|mkv|mov)$/i);

  if (isMediaStream) {
    return; // Pass through directly to browser's native media engine
  }

  // 3. API calls to Hugging Face or GitHub should always be Network-First (live data)
  if (url.hostname.includes('huggingface.co') || url.hostname.includes('github.com')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // 4. Immutable CDN assets (Tailwind, Lucide, Google Fonts, jsmediatags, Motion): Cache-First
  const isCdn = url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('cdn.jsdelivr.net');

  if (isCdn) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        });
      })
    );
    return;
  }

  // 5. App Shell assets (HTML, CSS, JS, manifest): Network-First, fallback to Cache
  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkRes;
      })
      .catch(() => caches.match(req))
  );
});

