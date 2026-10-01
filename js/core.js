"use strict";

var canvas = document.getElementById("stage");
var c2d = canvas.getContext("2d");
var hintEl = document.getElementById("hint");

// A phone or tablet: no hover, no space bar. Swaps the intro wording and
// help to touch (.touch-only / .desktop-only in the markup).
var IS_TOUCH = !!(window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches);
if (IS_TOUCH) document.documentElement.classList.add("touch");
var revealToggle = document.getElementById("revealToggle");
var gridToggle = document.getElementById("gridToggle");
var clearBtn = document.getElementById("clearBtn");

var nodePanel = document.getElementById("nodePanel");
var nodePanelClose = document.getElementById("nodePanelClose");
var panelTitleEl = document.getElementById("panelTitle");
var lockToggle = document.getElementById("lockToggle");
var timbreGroup = document.getElementById("timbreGroup");
var colorGroup = document.getElementById("colorGroup");
var vibratoSlider = document.getElementById("vibratoSlider");
var reverbSlider = document.getElementById("reverbSlider");
var delaySlider = document.getElementById("delaySlider");
var stretchSlider = document.getElementById("stretchSlider");

var weatherBtn = document.getElementById("weatherBtn");
var weatherPanel = document.getElementById("weatherPanel");
var weatherPanelClose = document.getElementById("weatherPanelClose");
var fieldPanel = document.getElementById("fieldPanel");
var fieldPanelClose = document.getElementById("fieldPanelClose");
var fieldStrengthSlider = document.getElementById("fieldStrengthSlider");
var fieldRemoveBtn = document.getElementById("fieldRemoveBtn");
var weatherToggle = document.getElementById("weatherToggle");
var weatherReverbSlider = document.getElementById("weatherReverbSlider");
var weatherDistSlider = document.getElementById("weatherDistSlider");
var weatherPhaseSlider = document.getElementById("weatherPhaseSlider");

var shutterEl = document.getElementById("shutter");
var snapshotBtn = document.getElementById("snapshotBtn");
var snapshotPanel = document.getElementById("snapshotPanel");
var snapshotPanelClose = document.getElementById("snapshotPanelClose");
var snapTimeEl = document.getElementById("snapTime");
var snapshotBodyEl = document.getElementById("snapshotBody");
var savedListEl = document.getElementById("savedList");

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

var W = 0, H = 0, dpr = Math.max(1, window.devicePixelRatio || 1);
function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") resumeAudio();
});
resize();

var DIATONIC_NOTES = [
  { name: "C", midi: 60 },
  { name: "D", midi: 62 },
  { name: "E", midi: 64 },
  { name: "F", midi: 65 },
  { name: "G", midi: 67 },
  { name: "A", midi: 69 },
  // B completes the white keys (added 1 October 2026). It brings the two most
  // restless white-key relationships with it: the B-C semitone and the
  // B-F tritone. Tension is half the point.
  { name: "B", midi: 71 }
];

var CHROMATIC_NOTES = [
  { name: "C", midi: 60 },
  { name: "C#", midi: 61 },
  { name: "D", midi: 62 },
  { name: "D#", midi: 63 },
  { name: "E", midi: 64 },
  { name: "F", midi: 65 },
  { name: "F#", midi: 66 },
  { name: "G", midi: 67 },
  { name: "G#", midi: 68 },
  { name: "A", midi: 69 },
  { name: "A#", midi: 70 },
  { name: "B", midi: 71 }
];

var chromaticMode = false;
function activeNotes() {
  return chromaticMode ? CHROMATIC_NOTES : DIATONIC_NOTES;
}

var ATTACK = 1.0, SUSTAIN = 1.1, RELEASE = 1.7, TOTAL = ATTACK + SUSTAIN + RELEASE;
var BASE_GAIN = 0.16;
var MAX_NODES = 8;
var MAX_HITS = 4;
var DECAY = 0.68;
var HIT_RADIUS = 30;
var MOVE_THRESHOLD = 6;

var DEFAULT_VIBRATO = 0.35;
var DEFAULT_REVERB = 0;
var DEFAULT_DELAY = 0.6;
var DEFAULT_STRETCH = 1;
var STRETCH_MIN = 0.5, STRETCH_MAX = 3;
function sliderToStretch(v) { return lerp(STRETCH_MIN, STRETCH_MAX, v / 100); }
function stretchToSlider(s) { return Math.round(((s - STRETCH_MIN) / (STRETCH_MAX - STRETCH_MIN)) * 100); }

var audioCtx = null, masterGain = null, compressor = null;
var delayNode = null, feedbackGain = null, wetGain = null;
var reverbNode = null, reverbOutGain = null;
var weatherBus = null, weatherReverbSend = null, weatherDistSend = null, weatherPhaseSend = null;
var weatherEnabled = false;
