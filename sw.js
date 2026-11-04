// Trove PWA Service Worker
const CACHE_NAME = 'trove-pwa-v64';

// Core App Shell assets to pre-cache on install
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './js/utils.js',
  './js/state.js',
  './js/settings.js',
  './js/equalizer.js',
  './js/player.js',
  './js/activity.js',
  './js/importer.js',
  './js/recommendations.js',
  './js/lyrics.js',
  './js/playlists.js',
  './js/explorer.js',
  './js/gestures.js',
  './js/app.js',
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

// Install: pre-cache the shell bypassing browser HTTP cache and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Force network reload for all precache assets to avoid stale browser HTTP cache
      const cachePromises = PRECACHE_ASSETS.map((asset) => {
        return fetch(new Request(asset, { cache: 'reload' }))
          .then((response) => {
            if (response.ok) {
              return cache.put(asset, response);
            }
          })
          .catch((err) => {
            console.warn('Precache skip for:', asset, err);
          });
      });
      return Promise.all(cachePromises);
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
            console.log('Purging stale cache:', key);
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

  // 1.5. Trove Stream Proxy: Stream media progressively with HTTP 206 Range support
  if (url.searchParams.has('trove_stream')) {
    event.respondWith(handleStreamProxy(req));
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
  // For HTML documents/navigations, ALWAYS fetch with cache: 'no-cache' so browser HTTP cache doesn't block updates
  const isNavOrHtml = req.mode === 'navigate' || 
    url.pathname.endsWith('/') || 
    url.pathname.endsWith('index.html');

  const fetchOptions = isNavOrHtml ? { cache: 'no-cache' } : {};

  event.respondWith(
    fetch(new Request(req, fetchOptions))
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

// Progressive Media Stream Proxy for instant playback and instant Range scrubs
async function handleStreamProxy(request) {
  const reqUrl = new URL(request.url);
  const targetUrl = reqUrl.searchParams.get('url');
  const token = reqUrl.searchParams.get('token');

  if (!targetUrl) {
    return new Response('Missing target media URL', { status: 400 });
  }

  const headers = new Headers();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (request.headers.has('range')) {
    headers.set('Range', request.headers.get('range'));
  }

  try {
    const res = await fetch(targetUrl, {
      headers,
      redirect: 'follow'
    });

    const resHeaders = new Headers();
    const forwardHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
      'cache-control'
    ];
    for (const h of forwardHeaders) {
      const val = res.headers.get(h);
      if (val) resHeaders.set(h, val);
    }
    if (!resHeaders.has('accept-ranges')) {
      resHeaders.set('accept-ranges', 'bytes');
    }

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders
    });
  } catch (err) {
    console.error('Service Worker stream proxy error:', err);
    return new Response('Stream fetch failed', { status: 502 });
  }
}
