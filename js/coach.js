"use strict";

// ── First-run intro — learning by doing, not slides. One short line at a
// time, and it moves on when the thing has actually been done: place a
// note, lock two, set them drifting, open one to shape it. Shown once
// (remembered in localStorage), skippable, and replayable from the help
// card. It replaces the long intro text on that first visit.

var COACH_KEY = "aeolaIntroDone";
var COACH_OUTRO_MS = 4500;

var coachEl = document.getElementById("coach");
var coachTextEl = document.getElementById("coachText");
var coachStep = -1;          // -1 = not running
var coachMenuOpened = false;
var coachFinished = false;   // finished or skipped during this visit
// Has this browser been through the intro before? Read once, up front —
// the dock (room.js) shows its buttons straight away for these people.
var introSeenAtLoad = (function () {
  try { return localStorage.getItem("aeolaIntroDone") === "1"; } catch (e) { return false; }
})();
var coachPanelOpened = false;
var coachOutroUntil = 0;
var coachTargetEl = null;

function coachVerb() { return IS_TOUCH ? "Tap" : "Click"; }

function ownNotes() {
  return nodes.filter(function (n) { return !n.pruned && n.kind !== "field" && !n._flightId; });
}

var COACH_STEPS = [
  {
    text: function () { return coachVerb() + " anywhere to place a note."; },
    done: function () { return ownNotes().length >= 1; },
    target: function () { return null; }
  },
  {
    text: function () { return "Place another, then " + coachVerb().toLowerCase() + " lock all to make them stay."; },
    done: function () {
      var own = ownNotes();
      return own.length >= 2 && own.every(function (n) { return n.frozen; });
    },
    target: function () { return document.getElementById("dockLockBtn"); }
  },
  {
    text: function () { return coachVerb() + " drift and let them wander."; },
    done: function () { return driftActive; },
    target: function () { return document.getElementById("dockDriftBtn"); }
  },
  {
    text: function () { return coachVerb() + " a note to shape its sound."; },
    done: function () { return coachPanelOpened; },
    target: function () { return null; }
  },
  {
    // Everything beyond drift and lock all lives in the menu now, on every
    // screen — so the intro shows the way there instead of just naming it.
    text: function () { return "Open the menu ☰ — tuning, flight mode and more live there."; },
    done: function () { return coachMenuOpened; },
    target: function () { return document.getElementById("menuBtn"); }
  }
];

function coachNotify(event) {
  if (event === "panel") coachPanelOpened = true;
  if (event === "menu") coachMenuOpened = true;
}

function setCoachText(text) {
  coachTextEl.textContent = text;
  coachTextEl.classList.remove("swap");
  void coachTextEl.offsetWidth; // restart the fade for each new line
  coachTextEl.classList.add("swap");
}

function setCoachTarget(el) {
  if (coachTargetEl === el) return;
  if (coachTargetEl) coachTargetEl.classList.remove("coach-target");
  coachTargetEl = el;
  if (el) el.classList.add("coach-target");
}

function startCoach(fromHelp) {
  track("intro-started", { replay: !!fromHelp });
  coachStep = 0;
  coachPanelOpened = false;
  coachMenuOpened = false;
  coachOutroUntil = 0;
  // The intro replaces the long hint text — gone at once, not faded out.
  hintEl.style.transition = "none";
  hintEl.classList.add("hidden");
  void hintEl.offsetWidth;
  hintEl.style.transition = "";
  setCoachText(COACH_STEPS[0].text());
  coachEl.hidden = false;
  if (fromHelp) markInteracted();
}

function endCoach() {
  coachStep = -1;
  coachFinished = true;
  coachEl.hidden = true;
  setCoachTarget(null);
  try { localStorage.setItem(COACH_KEY, "1"); } catch (e) {}
}

// Called every frame from draw(): advance when the current step is done.
function updateCoach(now) {
  if (coachStep < 0) return;
  // Flight mode takes the room over; step aside until it ends.
  var away = flightIsOn();
  if (coachEl.hidden !== away) coachEl.hidden = away;
  if (away) { setCoachTarget(null); return; }

  if (coachStep >= COACH_STEPS.length) {
    if (now > coachOutroUntil) endCoach();
    return;
  }
  var step = COACH_STEPS[coachStep];
  if (step.done()) {
    coachStep++;
    track("intro-step", { step: coachStep });
    if (coachStep >= COACH_STEPS.length) {
      setCoachText("That's the heart of it. Now find what resonates with you.");
      track("intro-completed");
      setCoachTarget(null);
      coachOutroUntil = now + COACH_OUTRO_MS;
      return;
    }
    setCoachText(COACH_STEPS[coachStep].text());
    step = COACH_STEPS[coachStep];
  }
  var target = step.target();
  setCoachTarget(target && !target.hidden ? target : null);
}

document.getElementById("coachSkip").addEventListener("click", function () {
  track("intro-skipped", { step: coachStep });
  endCoach();
});
document.getElementById("helpIntroBtn").addEventListener("click", function () {
  closeHelp();
  closeMenu();
  startCoach(true);
});

(function maybeStartCoach() {
  var seen = false;
  try { seen = localStorage.getItem(COACH_KEY) === "1"; } catch (e) {}
  // Someone opening a shared room came to hear that room, not a tutorial.
  var sharedRoom = /^#room=/.test(location.hash);
  if (!seen && !sharedRoom) startCoach(false);
})();
