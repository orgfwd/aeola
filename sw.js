// Aeola's offline mode. Everything the app needs is cached on first visit,
// so it opens and plays in airplane mode — where it was born. Only flight
// mode's live traffic (api/flights) needs the network, and it's never
// cached: stale air traffic would be a lie.
//
// Strategy: the whole app is cached as one versioned set, served
// cache-first. A new upload reaches phones by bumping AEOLA_VERSION in
// js/version.js (imported below): that changes this worker, the browser
// installs it, it caches the new set in full, and deletes the old one.
// Serving a set atomically means a phone never mixes files from two
// builds. The flip side: forget to bump the version and returning
// visitors keep the old build.
importScripts("js/version.js");

var CACHE = "aeola-" + AEOLA_VERSION;
var APP_FILES = [
  "./",
  "index.html",
  "theory.html",
  "manifest.webmanifest",
  "css/aeola.css",
  "js/version.js",
  "js/core.js",
  "js/metrics.js",
  "js/audio.js",
  "js/harmony.js",
  "js/capture.js",
  "js/room.js",
  "js/drift.js",
  "js/flight.js",
  "js/synchroscope.js",
  "js/render.js",
  "js/chrome.js",
  "js/panels.js",
  "js/snapshot.js",
  "js/input.js",
  "js/coach.js",
  "js/main.js",
  "js/vendor/lame.min.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache: "reload" skips the HTTP cache, so a fresh install really
      // gets the files just uploaded, not copies the browser kept.
      return cache.addAll(APP_FILES.map(function (url) { return new Request(url, { cache: "reload" }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return (k.indexOf("aeola-") === 0 || k.indexOf("klang-") === 0) && k !== CACHE; // klang-: caches from before the rename
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") !== -1 || url.pathname.indexOf("flights.php") !== -1) return; // live data: always the network

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      // A page request gets that page if it's cached (theory.html); anything
      // else — "/", a shared link with a #room=… hash (never sent) or a query
      // string — opens the cached app.
      var lookup = cache.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === "navigate" ? cache.match("index.html") : null);
      });
      return lookup.then(function (hit) {
        return hit || fetch(req);
      });
    })
  );
});
