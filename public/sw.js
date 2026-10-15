// MoneyMinder service worker. Pre-caches the app shell for offline launch,
// serves static assets cache-first, and is network-first for /api/ (so data
// stays fresh and API responses are never cached). ponytail: ~one file, no libs.
const CACHE = "mm-shell-v14";

// The full app shell: every page + its CSS/JS + manifest + icons.
const SHELL = [
  "/index.html",
  "/login.html",
  "/household.html",
  "/scan.html",
  "/receipts.html",
  "/receipt.html",
  "/profile.html",
  "/pilot.html",
  "/demo.html",
  "/privacy.html",
  "/css/app.css",
  "/js/api.js",
  "/js/nav.js",
  "/js/charts.js",
  "/js/toast.js",
  "/js/pwa.js",
  "/js/onboard.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/images/moneyminder-dashboard.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // let cross-origin (UPI/WhatsApp) pass through

  // API: network-first, no caching of responses. Offline -> clear JSON error.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(JSON.stringify({ error: "You're offline. Reconnect to load fresh data." }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    return;
  }

  // Navigations: try network, fall back to the cached page, then to index.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(url.pathname).then((hit) => hit || caches.match("/index.html"))
      )
    );
    return;
  }

  // Static assets: cache-first, then fill the cache on a miss.
  event.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
