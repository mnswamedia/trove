// Trove PWA Service Worker
const CACHE_NAME = 'trove-pwa-v75';
const CDN_CACHE_NAME = 'trove-cdn-v1';

const GOOGLE_FONTS_CSS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap';

// Core App Shell & self-hosted vendor assets to pre-cache on install
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
  './assets/vendor/tailwindcss.js',
  './assets/vendor/lucide.min.js',
  './assets/vendor/jsmediatags.min.js',
  './assets/vendor/motion.js',
  './assets/favicon.png',
  './assets/icons/icon-16x16.png',
  './assets/icons/icon-32x32.png',
  './assets/icons/icon-48x48.png',
  './assets/icons/icon-64x64.png',
  './assets/icons/icon-96x96.png',
  './assets/icons/icon-128x128.png',
  './assets/icons/icon-144x144.png',
  './assets/icons/icon-152x152.png',
  './assets/icons/icon-180x180.png',
  './assets/icons/icon-192x192.png',
  './assets/icons/icon-192x192-maskable.png',
  './assets/icons/icon-384x384.png',
  './assets/icons/icon-512x512.png',
  './assets/icons/icon-512x512-maskable.png'
];

// Best-effort precache of Google Fonts CSS + woff2 files so typography renders offline
async function precacheFonts() {
  try {
    const cdnCache = await caches.open(CDN_CACHE_NAME);
    const cssRes = await fetch(GOOGLE_FONTS_CSS_URL, { mode: 'cors' });
    if (!cssRes || !cssRes.ok) return;
    await cdnCache.put(GOOGLE_FONTS_CSS_URL, cssRes.clone());
    const cssText = await cssRes.text();
    const fontUrls = Array.from(cssText.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)).map(m => m[1]);
    const uniqueUrls = [...new Set(fontUrls)];
    await Promise.all(uniqueUrls.map(async (fontUrl) => {
      try {
        const existing = await cdnCache.match(fontUrl);
        if (existing) return;
        const fontRes = await fetch(fontUrl, { mode: 'cors' });
        if (fontRes && (fontRes.ok || fontRes.type === 'opaque')) {
          await cdnCache.put(fontUrl, fontRes);
        }
      } catch (_) {}
    }));
  } catch (_) {}
}

// Install: pre-cache the shell bypassing browser HTTP cache and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
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
      }),
      precacheFonts()
    ]).then(() => self.skipWaiting())
  );
});

// Activate: purge stale app shell caches (preserve persistent CDN font cache) and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== CDN_CACHE_NAME) {
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

  // 3. API/storage calls to Hugging Face or GitHub: Network-First, caching lightweight covers/metadata for offline fallback
  if (url.hostname.includes('huggingface.co') || url.hostname.includes('github.com')) {
    const isCacheableAsset = url.hostname.includes('huggingface.co') &&
      (url.pathname.includes('/covers/') || url.pathname.includes('/metadata/'));
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (isCacheableAsset && networkRes && networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 4. CDN assets (Google Fonts CSS/woff2 and any external fallbacks): Cache-First in persistent CDN cache
  const isCdn = url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('cdn.jsdelivr.net');

  if (isCdn) {
    event.respondWith(
      caches.open(CDN_CACHE_NAME).then((cache) => {
        return cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((networkRes) => {
            // Accept CORS (200) and no-cors opaque responses (status 0)
            if (networkRes && (networkRes.status === 200 || networkRes.type === 'opaque')) {
              const clone = networkRes.clone();
              cache.put(req, clone);
            }
            return networkRes;
          });
        });
      })
    );
    return;
  }

  // 4.5. Self-hosted vendor bundles & app icons: Cache-First (updated cleanly whenever CACHE_NAME bumps)
  const isStaticAsset = url.origin === self.location.origin && (
    url.pathname.includes('/assets/vendor/') ||
    url.pathname.includes('/assets/icons/') ||
    url.pathname.endsWith('/assets/favicon.png')
  );

  if (isStaticAsset) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(req, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              cache.put(req, networkRes.clone());
            }
            return networkRes;
          });
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
      .catch(async () => {
        const cached = await caches.match(req, { ignoreSearch: isNavOrHtml });
        if (cached) return cached;
        if (isNavOrHtml) {
          return caches.match('./index.html');
        }
        return Response.error();
      })
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

  const clientRange = request.headers.get('range') || 'bytes=0-';

  try {
    let finalUrl = targetUrl;
    let authHeaders = {};
    if (token) {
      authHeaders['Authorization'] = `Bearer ${token}`;
    }

    // 1. Resolve redirect to get direct CDN/S3 URL without losing Range header
    try {
      const redirectCheck = await fetch(finalUrl, {
        method: 'GET',
        headers: { ...authHeaders, 'Range': 'bytes=0-0' },
        redirect: 'manual'
      });
      if (redirectCheck.status >= 300 && redirectCheck.status < 400 && redirectCheck.headers.get('location')) {
        finalUrl = redirectCheck.headers.get('location');
        authHeaders = {}; // S3/CDN presigned URL has auth in query params
      }
    } catch (_) {}

    // 2. Fetch directly with the exact Range requested by the browser
    const rangeHeaders = {
      ...authHeaders,
      'Range': clientRange
    };

    const res = await fetch(finalUrl, {
      headers: rangeHeaders,
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

    // Ensure 206 Partial Content status so Chromium/Safari audio decoder begins immediate playback
    let status = res.status;
    if (status === 200 && clientRange) {
      status = 206;
      const totalLen = parseInt(res.headers.get('content-length') || '0', 10);
      if (totalLen > 0 && !resHeaders.has('content-range')) {
        resHeaders.set('content-range', `bytes 0-${totalLen - 1}/${totalLen}`);
      }
    }

    return new Response(res.body, {
      status: status,
      statusText: status === 206 ? 'Partial Content' : res.statusText,
      headers: resHeaders
    });
  } catch (err) {
    console.error('Service Worker stream proxy error:', err);
    return new Response('Stream fetch failed', { status: 502 });
  }
}
