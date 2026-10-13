// Service worker: app-skal caches, data hentes altid live fra Supabase
const CACHE = "reservedele-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;          // aldrig cache data
  // Netværk først (så opdateringer slår igennem), fald tilbage til cache offline
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && (url.origin === location.origin || /jsdelivr|unpkg/.test(url.hostname))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});
