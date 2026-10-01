"use strict";

document.getElementById("captureBtn").addEventListener("click", captureFieldRecording);
document.getElementById("exportBtn").addEventListener("click", toggleMasterRecording);

// ── Segmented controls: every option visible, one tap away. setSeg() is
// the single place a control's highlighted option is set, so code that
// changes the state elsewhere (flight falling back to off) stays in sync.
function setSeg(id, value) {
  Array.prototype.forEach.call(document.getElementById(id).querySelectorAll("button[data-value]"), function (b) {
    var on = b.getAttribute("data-value") === String(value);
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}
function bindSeg(id, onPick) {
  document.getElementById(id).addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button[data-value]") : null;
    if (b) onPick(b.getAttribute("data-value"));
  });
}

bindSeg("flightSeg", function (v) {
  setFlightMode(parseInt(v, 10));
  if (flightIsOn()) closeMenu(); // step back and watch the sky fill
});
bindSeg("northSeg", function (v) {
  initAudio();
  resumeAudio();
  setNorth(v === "true");
  setSeg("northSeg", trueNorth ? "true" : "magnetic");
});
bindSeg("qualitySeg", function (v) {
  chordQualityMode = v;
  setSeg("qualitySeg", v);
});
bindSeg("notesSeg", function (v) {
  chromaticMode = v === "12";
  setSeg("notesSeg", v);
});
setSeg("flightSeg", flightIndex);
setSeg("northSeg", trueNorth ? "true" : "magnetic");
setSeg("qualitySeg", chordQualityMode);
setSeg("notesSeg", chromaticMode ? "12" : "7");

// Clearing the room can't be undone, so it asks twice: the first tap arms
// it for a few seconds, the second one clears.
var CLEAR_ARM_MS = 3000;
var clearArmTimer = null;
function disarmClear() {
  if (clearArmTimer) { clearTimeout(clearArmTimer); clearArmTimer = null; }
  clearBtn.classList.remove("armed");
  clearBtn.textContent = "clear the airspace";
}
clearBtn.addEventListener("click", function () {
  if (!clearArmTimer) {
    clearBtn.classList.add("armed");
    clearBtn.textContent = (IS_TOUCH ? "tap" : "click") + " again to clear";
    clearArmTimer = setTimeout(disarmClear, CLEAR_ARM_MS);
    return;
  }
  disarmClear();
  clearAllNodes();
  closeMenu();
});

document.getElementById("dockDriftBtn").addEventListener("click", toggleDrift);
document.getElementById("dockLockBtn").addEventListener("click", toggleAllLocks);
updateDriftButtons();

// Feedback address assembled here, not written in the HTML, so bots
// harvesting the page source don't find it. The subject carries the version.
(function () {
  var addr = ["alex", "skepp.se"].join("@");
  document.getElementById("feedbackLink").href =
    "mailto:" + addr + "?subject=" + encodeURIComponent("Aeola " + AEOLA_VERSION + " feedback");
})();
document.getElementById("supportLink").addEventListener("click", function () { track("support-clicked"); });
document.getElementById("feedbackLink").addEventListener("click", function () { track("feedback-clicked"); });
document.getElementById("sourceLink").addEventListener("click", function () { track("source-clicked"); });
document.getElementById("paperLink").addEventListener("click", function () { track("paper-opened"); });

// "I'd want that" — counted once per visit, then simply says thanks.
var appInterestBtn = document.getElementById("appInterestBtn");
appInterestBtn.addEventListener("click", function () {
  track("app-interest");
  appInterestBtn.disabled = true;
  appInterestBtn.textContent = "thanks — noted";
});

document.getElementById("versionStamp").textContent = "Aeola " + AEOLA_VERSION + " · " + AEOLA_BUILD_DATE;
console.info("Aeola " + AEOLA_VERSION + " (" + AEOLA_BUILD_DATE + ")");

// Offline mode — see sw.js. Not on file:// (service workers need http/https).
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(function (err) {
      console.warn("Offline mode unavailable:", err);
    });
  });
}

// Last of all — everything above (SHARE_COLORS/SHARE_TIMBRES etc.) must
// have run before a shared link can be decoded.
loadSharedRoomFromHash();

draw();
