const CACHE_NAME = "lan-print-shell-v2";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only ever intercept simple GET requests for the cached app shell.
  // File uploads (print jobs) are POST requests with a body — trying to
  // route those through caches.match()/fetch() here can cause the request
  // to be sent twice in some browsers, which is exactly wrong for a print
  // job. Let the browser handle anything that isn't a plain GET itself.
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never cache API calls or firmware downloads — those must always hit the live server
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/relay/") || url.pathname.startsWith("/firmware")) return;

  // Cross-origin requests (the app calling a discovered server IP) — just
  // pass through to the network, don't try to cache-match them.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
