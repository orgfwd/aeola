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

function track(name, data) {
  try {
    if (window.umami && typeof window.umami.track === "function") window.umami.track(name, data);
  } catch (e) {}
}

// Once per page load, for "first time this happened" events.
var trackedOnce = {};
function trackOnce(name, data) {
  if (trackedOnce[name]) return;
  trackedOnce[name] = true;
  track(name, data);
}

// How people run Aeola: home-screen app or browser tab, touch or mouse.
// Sent once Umami has loaded (it's deferred), so it isn't lost.
window.addEventListener("load", function () {
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  setTimeout(function () {
    track("session", { mode: standalone ? "home-screen" : "browser", input: IS_TOUCH ? "touch" : "mouse" });
  }, 1500);
});
