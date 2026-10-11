/**
 * The service worker that makes both pages installable as apps.
 *
 * Network first, always: a new deploy must reach the phones at once, so the
 * cache is only a fallback for the page files while there is no network (the
 * pages then show that they are offline until it is back). The API, and
 * anything that is not a GET for this site, is never touched.
 */
const CACHE = "swish-kassa-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" || url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    } catch (err) {
      // display?code=… offline still finds the cached page.
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});
