"use strict";

// ── Usage metrics — anonymous counts via Umami (cloud.umami.is): no
// cookies, no personal data, no consent banner needed. The script tag in
// index.html only counts on aeola.vercel.app, drops the URL's #hash (a
// shared room lives there) and respects Do Not Track.
//
// Every event goes through track(), which does nothing if Umami is
// blocked, offline or not loaded yet — Aeola must never depend on it.
// Events are named after what a person did, with small, non-identifying
// details (an airport, a step number, an error name). Never content.

// Umami loads with `defer`, after Aeola has started — so events from the
// first moments (the intro starting) wait in a short queue and go out once
// it's ready. If it never arrives (blocked, offline) the queue is dropped.
var METRICS_QUEUE_MAX = 50;
var METRICS_WAIT_MS = 20000;
var metricsQueue = [];
var metricsWaitStarted = Date.now();

function umamiReady() {
  return !!(window.umami && typeof window.umami.track === "function");
}

function flushMetrics() {
  if (!umamiReady()) {
    if (Date.now() - metricsWaitStarted < METRICS_WAIT_MS) setTimeout(flushMetrics, 400);
    else metricsQueue = [];
    return;
  }
  var q = metricsQueue; metricsQueue = [];
  q.forEach(function (e) { try { window.umami.track(e[0], e[1]); } catch (err) {} });
}

function track(name, data) {
  try {
    if (umamiReady()) { window.umami.track(name, data); return; }
    if (metricsQueue.length < METRICS_QUEUE_MAX) metricsQueue.push([name, data]);
  } catch (e) {}
}
setTimeout(flushMetrics, 400);

// Once per page load, for "first time this happened" events.
var trackedOnce = {};
function trackOnce(name, data) {
  if (trackedOnce[name]) return;
  trackedOnce[name] = true;
  track(name, data);
}

// Has this browser opened Aeola before? Read from two things Aeola stores
// for its own sake — the offline copy (an installed service worker already
// controls the page) and the "intro seen" flag — never from anything stored
// for statistics. Read now, before this page load changes either. It is a
// plain yes/no on the session event: no ID, nothing that follows a person.
var RETURNING_VISIT = (function () {
  var offlineCopy = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  var introSeen = false;
  try { introSeen = localStorage.getItem("aeolaIntroDone") === "1"; } catch (e) {}
  return offlineCopy || introSeen;
})();

// How people run Aeola: home-screen app or browser tab, touch or mouse.
// Sent once Umami has loaded (it's deferred), so it isn't lost.
window.addEventListener("load", function () {
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  setTimeout(function () {
    track("session", { mode: standalone ? "home-screen" : "browser", input: IS_TOUCH ? "touch" : "mouse", returning: RETURNING_VISIT });
  }, 1500);
});
