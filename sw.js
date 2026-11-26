// Gravity – Offline-Zwischenspeicher
// Bei jeder neuen App-Fassung die Kennung hochzählen (v2, v3, ...).
const CACHE = "gravity-v11";
const DATEIEN = ["./", "./index.html", "./app.css?v=8", "./app.js?v=8", "./pro.js?v=1", "./native.js?v=1", "./build-config.js", "./parks.js?v=6", "./crew.js?v=10", "./account.js?v=6", "./manifest.json",
  "./datenschutz.html", "./nutzungsbedingungen.html", "./impressum.html",
  "./icon-180.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(DATEIEN.map((f) => c.add(f).catch(() => {})))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const namen = await caches.keys();
    await Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Erst Netz, bei fehlendem Netz (z. B. im Funkloch am Berg) aus dem Speicher
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const frisch = await fetch(req);
      if (frisch.ok) {
        const c = await caches.open(CACHE);
        c.put(req, frisch.clone()).catch(() => {});
      }
      return frisch;
    } catch (err) {
      const alt = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
      return alt || caches.match("./index.html");
    }
  })());
});
