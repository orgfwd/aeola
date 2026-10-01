"use strict";

// ── The opening title. It tunes itself in, using the same physics as the
// room. Each letter of the wordmark has a green twin slightly out of tune
// with it. While they disagree, the letter beats: it swells and fades, and
// the twin sways beside it. The beat slows, the pair lock into one letter,
// and the next letter starts. The order is unequal on purpose, like the
// tape loops. Underneath, a string vibrates in its first few harmonics,
// strongly while the letters settle and then only as much as a breath of
// air would move it (the aeolian harp). A small amber lamp lights once the
// whole word is in tune.
//
// It only runs while the title is visible, and stops once it has stepped
// aside. With reduced motion it shows the finished, tuned state at once.

var TITLE_LETTER_START = [0.25, 0.7, 1.0, 1.45, 1.65]; // s; unequal, never a metronome
var TITLE_TUNE_S = [1.9, 1.6, 2.1, 1.5, 1.8];          // how long each pair takes to agree
var TITLE_BEAT_HZ = 5.5;      // beat rate at first sight; it glides to 0
var TITLE_SWAY_EM = 0.14;     // the twin's furthest sway, in letter widths
var STRING_SETTLED_PX = 0.55; // a breath of air on the string once in tune

var titleEl = document.getElementById("title");
var titleLetters = Array.prototype.slice.call(titleEl.querySelectorAll(".wm-l"));
var titlePath = document.getElementById("wmStringPath");
var titleRaf = 0;
var titleT0 = 0;
var titleLast = 0;
var titlePhase = titleLetters.map(function () { return 0; });
var titleLocked = titleLetters.map(function () { return false; });
var titleAllLocked = false;

function titleReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function lockTitleLetter(i) {
  titleLocked[i] = true;
  var el = titleLetters[i];
  el.style.setProperty("--wm-a", "1");
  el.style.setProperty("--wm-dx", "0em");
  el.style.setProperty("--wm-g", "0");
  el.classList.add("wm-locked");
}

// Standing wave on a string fixed at both ends: harmonics 1–3, each at its
// own rate, so the shape never repeats exactly.
function drawTitleString(t, amp) {
  var d = "M0 12";
  for (var x = 8; x <= 400; x += 8) {
    var u = x / 400;
    var y = 12 +
      amp * (Math.sin(Math.PI * u) * Math.sin(t * 2.1) +
             0.45 * Math.sin(2 * Math.PI * u) * Math.sin(t * 3.3 + 1.1) +
             0.22 * Math.sin(3 * Math.PI * u) * Math.sin(t * 4.7 + 2.3));
    d += " L" + x + " " + y.toFixed(2);
  }
  titlePath.setAttribute("d", d);
}

function titleFrame(now) {
  if (!titleT0) { titleT0 = now; titleLast = now; }
  var t = (now - titleT0) / 1000;
  var dt = Math.min(0.05, (now - titleLast) / 1000);
  titleLast = now;

  var unsettled = 0;
  for (var i = 0; i < titleLetters.length; i++) {
    if (titleLocked[i]) continue;
    var el = titleLetters[i];
    var p = (t - TITLE_LETTER_START[i]) / TITLE_TUNE_S[i];
    if (p < 0) { unsettled++; continue; }
    if (p >= 1) { lockTitleLetter(i); continue; }
    unsettled++;
    // The beat slows as the pair approaches agreement (rate ∝ the remaining
    // detune), and the phase is integrated so the slow-down is smooth.
    var left = 1 - p;
    titlePhase[i] += 2 * Math.PI * TITLE_BEAT_HZ * left * left * dt;
    var beat = Math.cos(titlePhase[i]);
    var arrive = Math.min(1, p * 4); // fades up out of nothing first
    el.style.setProperty("--wm-a", (arrive * (0.55 + 0.45 * Math.abs(Math.cos(titlePhase[i] / 2)))).toFixed(3));
    el.style.setProperty("--wm-dx", (TITLE_SWAY_EM * Math.pow(left, 1.5) * beat).toFixed(4) + "em");
    el.style.setProperty("--wm-g", (arrive * 0.85 * left).toFixed(3));
  }

  if (!unsettled && !titleAllLocked) {
    titleAllLocked = true;
    titleEl.classList.add("in-tune");
  }
  // String: excited by every letter still beating, then left to the air.
  drawTitleString(t, STRING_SETTLED_PX + 2.6 * unsettled / titleLetters.length);

  titleRaf = requestAnimationFrame(titleFrame);
}

function titleStepAside() {
  titleEl.classList.add("hidden");
  // Let the fade finish, then stop drawing a string nobody can see.
  setTimeout(function () {
    if (titleRaf) cancelAnimationFrame(titleRaf);
    titleRaf = 0;
  }, 1600);
}

(function startTitle() {
  if (titleReducedMotion()) {
    titleLetters.forEach(function (el, i) { lockTitleLetter(i); });
    titleAllLocked = true;
    titleEl.classList.add("in-tune");
    return;
  }
  titleEl.classList.add("tuning");
  titleRaf = requestAnimationFrame(titleFrame);
})();
