// Bump on every upload. One source for two readers: the page (help card
// footer, console) and the service worker (sw.js imports this file), whose
// offline cache is named after the version — so bumping it is also what
// makes phones fetch the new build instead of replaying the cached one.
var AEOLA_VERSION = "v30";
var AEOLA_BUILD_DATE = "1 October 2026";
