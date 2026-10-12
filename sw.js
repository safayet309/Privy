// Bump this on every deploy so old caches are dropped.
const CACHE = "privy-shell-v2";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./icon.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Don't let one missing file break installation.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Supabase API / realtime / storage: never touch.
  if (url.hostname.endsWith("supabase.co")) return;

  // Same-origin app files: network first (so updates show up), cache as offline fallback.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true }).then((hit) =>
            hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())
          )
        )
    );
    return;
  }

  // Supabase JS library from CDN: cache-first so the app shell can open offline.
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
      )
    );
  }
});
