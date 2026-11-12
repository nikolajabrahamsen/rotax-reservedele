// Service worker: app-skal caches til offline, data hentes altid live fra Supabase.
// VED OPDATERING: hæv VERSION her OG ?v=… i index.html (samme tal).
const VERSION = 10;
const CACHE = "reservedele-v" + VERSION;
const SHELL = ["./", "index.html", `styles.css?v=${VERSION}`, `i18n.js?v=${VERSION}`, `app.js?v=${VERSION}`, `config.js?v=${VERSION}`,
  "manifest.webmanifest", "icons/app-icon-192.png", "icons/app-icon-512.png",
  "icons/app-apple-touch-icon.png", "icons/rotax-logo.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
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
  const sameOrigin = url.origin === location.origin;
  // Netværk først. Egne filer spørger altid serveren om der er en nyere version
  // (browserens 10-minutters cache springes over), så opdateringer slår igennem med det samme.
  const netReq = !sameOrigin ? req
    : req.mode === "navigate" ? new Request(req.url, { cache: "no-cache", credentials: "same-origin" })
    : new Request(req, { cache: "no-cache" });
  e.respondWith(
    fetch(netReq).then((res) => {
      if (res.ok && (sameOrigin || /jsdelivr|unpkg/.test(url.hostname))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((r) =>
      r || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
