"use strict";

/* Ocean's service worker: lets the phone install Ocean as an app and opens
   the app shell quickly. Chats and anything under /api are never cached;
   they always come fresh from the server. */

const CACHE = "ocean-shell-v11";
const SHELL = [
  "/", "/app.css?v=11", "/app.js?v=11", "/vendor/marked.js?v=11", "/vendor/purify.js?v=11",
  "/icon.svg?v=11", "/fonts/inter-latin.woff2", "/manifest.json", "/pwa/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/brains" || url.pathname === "/health") return;

  if (req.mode === "navigate") {
    // Always try the network first so updates show straight away.
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && SHELL.includes(url.pathname + url.search)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
