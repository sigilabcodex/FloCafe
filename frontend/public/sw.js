const CACHE_NAME = 'flo-v21';
const APP_CACHE_PATTERN = /^flo-v\d+$/;
const PUBLIC_SHELL_PATHS = new Set(['/dashboard', '/pos', '/purchasing']);
const PRECACHE_URLS = [
  '/dashboard',
  '/pos',
  '/purchasing',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        await Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => undefined)));
        // The shopping view is a static export route. Cache only that public
        // shell and its same-origin Next static chunks; never API responses.
        try {
          const response = await fetch('/purchasing', { cache: 'reload' });
          if (response.ok) {
            // Next's desktop export may redirect /purchasing to its trailing
            // slash route. Store both request keys so navigation fallback works
            // regardless of the configured URL form.
            await cache.put('/purchasing', response.clone());
            await cache.put('/purchasing/', response.clone());
            const html = await response.clone().text();
            const assetUrls = new Set();
            for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
              try {
                const url = new URL(match[1], self.location.origin);
                if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) {
                  assetUrls.add(url.pathname + url.search);
                }
              } catch { /* Ignore malformed markup references. */ }
            }
            await Promise.all([...assetUrls].map((url) => cache.add(url).catch(() => undefined)));
          }
        } catch { /* A missing shell cache must not prevent worker installation. */ }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => APP_CACHE_PATTERN.test(k) && k !== CACHE_NAME)
        .map((k) => caches.delete(k).catch(() => false)))
    ).then(() => self.clients.claim())
  );
});

// Cache keys are precached without a trailing slash (see PRECACHE_URLS), but
// requests for the same route can arrive with one — e.g. Next.js's <Link>
// prefetch of "/dashboard/" when trailingSlash is enabled for the desktop
// build. Normalizing avoids a spurious cache miss on an otherwise-cached page.
function normalizedUrlString(url) {
  const parsed = new URL(url);
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

function matchCached(request) {
  return caches.match(request)
    .then((match) => match || caches.match(normalizedUrlString(
      typeof request === 'string' ? request : request.url
    )))
    .catch(() => null);
}

// A route prefetch (e.g. <Link> hovering/entering the viewport) fetches a
// page path the same way a real subresource would, but with request.mode
// other than "navigate". Treat it like a navigation for fallback purposes —
// it targets one of our own pages, not a script/image/font — so it gets a
// real HTTP response instead of a network-error Response.
function isPageRequest(request) {
  if (request.mode === 'navigate') return true;
  const lastSegment = new URL(request.url).pathname.split('/').pop() || '';
  return !lastSegment.includes('.');
}

function isCacheablePublicRequest(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/_next/static/')) return true;
  if (['/manifest.json', '/icon-192.png', '/icon-512.png', '/logo.svg'].includes(url.pathname)) return true;
  if (request.mode === 'navigate' || isPageRequest(request)) {
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
    return PUBLIC_SHELL_PATHS.has(pathname);
  }
  return false;
}

function offlineResponse(request) {
  // Navigation (and page prefetches) need a real HTTP response so Electron
  // shows a useful offline state instead of a service-worker
  // promise-conversion error. True subresources (scripts, images, fonts) use
  // a network-error Response, which preserves normal failed-resource
  // semantics without inventing a body or caching a failure.
  if (isPageRequest(request)) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
  return typeof Response.error === 'function'
    ? Response.error()
    : new Response('', { status: 503, statusText: 'Offline' });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never cache API/setup/auth calls — these must reflect current DB state.
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/setup')
  ) return;
  if (!isCacheablePublicRequest(event.request, url)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Never cache server failures. In particular, a startup 503 must not
        // become the cached response that masks a server which is now ready.
        if (response.ok) {
          const clone = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone))
              .catch(() => undefined)
          );
        }

        // Network-first navigation can use a known-good shell when the local
        // server is temporarily returning an error during startup. Preserve a
        // non-navigation HTTP response as-is; it is already a valid Response.
        if (event.request.mode !== 'navigate' || response.ok || response.status < 500) {
          return response;
        }
        return matchCached(event.request)
          .then((cached) => cached || matchCached('/purchasing'))
          .then((cached) => cached || response);
      })
      .catch(() => matchCached(event.request)
        .then((cached) => cached || (
          isPageRequest(event.request) ? matchCached('/purchasing') : null
        ))
        .then((cached) => cached || offlineResponse(event.request))
      )
  );
});
