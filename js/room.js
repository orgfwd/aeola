"use strict";

var nodes = [];
var ripples = [];
var bursts = [];
var prevCollisions = {};
var nodeIdCounter = 1;
var revealEnabled = false;
var gridVisible = false;
var BAND_CENTERS = [0.165, 0.495, 0.83];
var currentSnapshot = null;
var snapshotLiveNodes = [];
var SAVED_COMBOS_KEY = "aeolaSavedCombos";

// Aeola was called Klang until 30 September 2026. Browsers that ran it under the
// old name keep their saved rooms, vocabulary and mic note: copied across
// once, never overwriting anything already saved under the new keys.
(function carryOverKlangStorage() {
  try {
    [["klangSavedCombos", "aeolaSavedCombos"], ["klangVocabulary", "aeolaVocabulary"], ["klangMicNoteShown", "aeolaMicNoteShown"]]
      .forEach(function (pair) {
        var old = localStorage.getItem(pair[0]);
        if (old !== null && localStorage.getItem(pair[1]) === null) localStorage.setItem(pair[1], old);
      });
  } catch (e) {}
})();

// ── Zones — invisible regions of the canvas where sound behaves
// differently. Deliberately undiscoverable by design: no legend, no
// visual marker in normal play. Found by placing notes and noticing.
// Coordinates are fractions of W/H so zones hold position across resizes.
var ZONES = [
  { cx: 0.22, cy: 0.30, r: 0.16, kind: "tail",   strength: 1.0 },
  { cx: 0.78, cy: 0.68, r: 0.18, kind: "tail",   strength: 0.7 },
  { cx: 0.50, cy: 0.50, r: 0.14, kind: "breath", strength: 1.0 }
];

function zoneAt(px, py) {
  var xf = px / W, yf = py / H;
  var best = null, bestStrength = 0;
  ZONES.forEach(function (z) {
    var dx = xf - z.cx, dy = yf - z.cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < z.r) {
      var s = z.strength * (1 - dist / z.r);
      if (s > bestStrength) { bestStrength = s; best = { kind: z.kind, strength: s }; }
    }
  });
  return best;
}

// ── Breathing — locked drones drift slowly instead of looping identically
// forever. Recomputed once per retrigger (every ~4-7s), not per-sample, so
// it needs no new audio-graph nodes. Phase offset uses node.id so several
// frozen notes don't breathe in lockstep.
var BREATHE_VIBRATO_PERIOD = 52;
var BREATHE_FILTER_PERIOD = 97;
var BREATHE_PITCH_PERIOD = 71;

function computeBreath(node, now) {
  var breath = { vibratoDelta: 0, filterFreqMult: 1, detuneWobble: 0, stretchMult: 1 };
  if (node.frozen && node.frozenAt != null) {
    var elapsed = now - node.frozenAt;
    var zb = node.zoneBreatheBoost || 0;
    var vibDepth = 0.10 + zb * 0.12;
    var filterDepth = 0.05 + zb * 0.05;
    var pitchDepthCents = 3 + zb * 3;
    breath.vibratoDelta = vibDepth * Math.sin((elapsed / BREATHE_VIBRATO_PERIOD) * Math.PI * 2 + node.id);
    breath.filterFreqMult = 1 + filterDepth * Math.sin((elapsed / BREATHE_FILTER_PERIOD) * Math.PI * 2 + node.id * 1.7);
    breath.detuneWobble = pitchDepthCents * Math.sin((elapsed / BREATHE_PITCH_PERIOD) * Math.PI * 2 + node.id * 2.3);
  }
  if (node.zone && node.zone.kind === "tail") {
    breath.stretchMult = 1 + node.zone.strength * 0.9;
  }
  return breath;
}

function bandIndex(yFrac) {
  return yFrac < 0.33 ? 0 : (yFrac > 0.66 ? 2 : 1);
}

function computePitch(px, py) {
  var notes = activeNotes();
  var xFrac = Math.max(0, Math.min(1, px / W));
  var yFrac = Math.max(0, Math.min(1, py / H));
  var idx = Math.min(notes.length - 1, Math.floor(xFrac * notes.length));
  var root = notes[idx];
  var octaveShift = yFrac < 0.33 ? 12 : (yFrac > 0.66 ? -12 : 0);
  return {
    rootMidi: root.midi + octaveShift,
    rootName: root.name,
    pan: (xFrac - 0.5) * 1.6
  };
}

// Glides the voices already sounding to a node's new rootMidi/pan.
// Shared by dragging (updateNodePosition), drift, flight and north.
function retuneActiveVoices(node, glideSeconds) {
  if (!(node.activeVoices && audioCtx)) return;
  var glide = glideSeconds != null ? glideSeconds : 0.12;
  var now = audioCtx.currentTime;
  node.activeVoices.forEach(function (v) {
    if (v.panner) {
      var target = Math.max(-1, Math.min(1, node.pan + v.offset));
      v.panner.pan.cancelScheduledValues(now);
      v.panner.pan.linearRampToValueAtTime(target, now + 0.08);
    }
    if (typeof v.semi === "number") {
      var newFreq = chordToneFreq(node.rootMidi, v.semi);
      // Anchor the ramp at where the voice is right now — without an
      // anchor a ramp starts from the last scheduled event, which may be
      // long gone — and remember the glide so the synchroscope can follow
      // the pitch as it actually moves rather than jumping to the target.
      var fromFreq = voiceFreqAt(v, now);
      v.oscillators.forEach(function (osc) {
        osc.frequency.cancelScheduledValues(now);
        osc.frequency.setValueAtTime(fromFreq, now);
        osc.frequency.linearRampToValueAtTime(newFreq, now + glide);
      });
      if (v.sub) {
        v.sub.frequency.cancelScheduledValues(now);
        v.sub.frequency.setValueAtTime(fromFreq / 2, now);
        v.sub.frequency.linearRampToValueAtTime(newFreq / 2, now + glide);
      }
      v.glideFrom = fromFreq;
      v.glideT0 = now;
      v.glideT1 = now + glide;
      if (v.filter && v.filter.type === "bandpass") {
        v.filter.frequency.cancelScheduledValues(now);
        v.filter.frequency.linearRampToValueAtTime(timbreFilterFreq(node.timbre, newFreq), now + glide);
      }
      v.freq = newFreq;
    }
  });
}

// Switching north glides every sounding voice to its new tuning — slowly
// enough (NORTH_GLIDE) that you can hear the beating inside a chord slow
// down and stop, rather than just jump to a different sound. Vibrato and
// chorus detune rescale at the same time (see TRUE_NORTH_STEADY).
var NORTH_GLIDE = 2.4;

function setNorth(isTrue) {
  if (isTrue && !trueNorth) track("north-true");
  trueNorth = !!isTrue;
  if (!audioCtx) return;
  var now = audioCtx.currentTime;
  var steady = northSteadiness();
  nodes.forEach(function (node) {
    if (node.pruned || node.kind === "field" || !node.activeVoices) return;
    retuneActiveVoices(node, NORTH_GLIDE);
    node.activeVoices.forEach(function (v) {
      v.oscillators.forEach(function (osc) {
        osc.detune.cancelScheduledValues(now);
        osc.detune.setTargetAtTime((osc._chorusCents || 0) * steady + (v.wobble || 0), now, NORTH_GLIDE / 3);
      });
      var vibTarget = lerp(0, 35, v.vibratoAmount || 0) * steady;
      v.vibratoDepths.forEach(function (vd) { vd.gain.setTargetAtTime(vibTarget, now, NORTH_GLIDE / 3); });
    });
  });
}

function updateNodePosition(node, px, py, glideSeconds) {
  if (node.kind === "field") {
    node.x = px; node.y = py;
    var fnowTs = performance.now();
    if (node._lastFieldUpdateAt && fnowTs - node._lastFieldUpdateAt < 90) return;
    node._lastFieldUpdateAt = fnowTs;
    var fp = fieldParamsFor(px, py);
    if (audioCtx) {
      var fnow = audioCtx.currentTime;
      node.filt.frequency.cancelScheduledValues(fnow);
      node.filt.frequency.linearRampToValueAtTime(fp.filterFreq, fnow + 0.12);
      node.delay.delayTime.cancelScheduledValues(fnow);
      node.delay.delayTime.linearRampToValueAtTime(fp.delayTime, fnow + 0.12);
      node.fb.gain.cancelScheduledValues(fnow);
      node.fb.gain.linearRampToValueAtTime(fp.feedback, fnow + 0.12);
    }
    return;
  }
  node.x = px;
  node.y = py;
  var pitch = computePitch(px, py);
  node.rootMidi = pitch.rootMidi;
  node.rootName = pitch.rootName;
  node.pan = pitch.pan;
  node.zone = zoneAt(px, py);
  node.zoneBreatheBoost = (node.zone && node.zone.kind === "breath") ? node.zone.strength : 0;
  retuneActiveVoices(node, glideSeconds);
}

var FADE_IN_STEP = 1.7;

// How far a node has "arrived" on screen, 0..1. Nodes given an appearMs
// (aircraft checking in) grow in over that time; everything else — a note
// you just placed — is there at once, since it answers your tap.
function nodeAppear(n, nowMs) {
  if (!n.appearMs || n.bornAt == null) return 1;
  var t = clamp((nowMs - n.bornAt) / n.appearMs, 0, 1);
  return 1 - Math.pow(1 - t, 3); // ease out
}

function hit(node, gainMult) {
  if (node.pruned) return;
  resumeAudio();
  var startTime = audioCtx.currentTime + 0.05;
  var breathObj = computeBreath(node, startTime);
  var effectiveStretch = (node.stretch || 1) * (breathObj.stretchMult || 1);
  node.activeVoices = playChord(node, startTime, BASE_GAIN * gainMult, breathObj);
  node.lastGain = gainMult;
  node.lastHitStart = startTime;
  node.lastStretch = effectiveStretch;
  ripples.push({
    x: node.x, y: node.y, quality: node.quality, rootName: node.rootName,
    start: performance.now(), peak: gainMult, sizeScale: node.sizeScale || 1,
    stretch: effectiveStretch
  });
  node.hitIndex++;

  var shouldContinue, nextGain;
  if (node.frozen) {
    shouldContinue = true;
    // A node with a fadeTarget arrives from the distance: it starts soft and
    // climbs to full strength over a few strikes (FADE_IN_STEP per strike).
    nextGain = node.fadeTarget ? Math.min(node.fadeTarget, gainMult * FADE_IN_STEP) : gainMult;
  } else if (node.releasing) {
    nextGain = gainMult * DECAY;
    shouldContinue = node.hitIndex < MAX_HITS && nextGain > 0.05;
  } else {
    nextGain = gainMult * DECAY;
    shouldContinue = node.hitIndex < MAX_HITS;
  }

  if (shouldContinue) {
    // A node with its own loopMs repeats at that fixed period, like a tape
    // loop, so several such nodes phase against each other and never fall
    // back into step. Everything else keeps the loose 4–7s random pulse.
    var waitMs = node.loopMs
      ? node.loopMs * (node.stretch || 1)
      : (4200 + Math.random() * 3000) * effectiveStretch;
    node.timerId = setTimeout(function () {
      hit(node, nextGain);
    }, waitMs);
  } else {
    node.timerId = null;
    node.pruned = true;
  }
}

function maxDragPx() {
  return Math.max(60, Math.min(W, H) * 0.22);
}

// Chord quality for new notes — random (a coin toss, which used to be the
// only behaviour), or forced major/minor. Random is the default; cycled
// from the menu's "new notes" control.

var CHORD_QUALITY_MODES = ["random", "major", "minor"];
var chordQualityMode = "random";
function pickQuality() {
  if (chordQualityMode === "major") return "major";
  if (chordQualityMode === "minor") return "minor";
  return Math.random() < 0.5 ? "major" : "minor";
}

function spawnNode(px, py, template) {
  // If the room is already full (nodes.length >= MAX_NODES), there must be
  // at least one unlocked tonal note to remove to make space — otherwise
  // the new note would immediately evict itself (the only unlocked one in
  // the array). Checked against the CURRENT, untouched state, before the
  // new note is even created.
  if (nodes.length >= MAX_NODES) {
    var hasEvictable = nodes.some(function (n) { return n.kind !== "field" && !n.frozen; });
    if (!hasEvictable) {
      showMaxNodesMessage();
      return null;
    }
  }
  var pitch = computePitch(px, py);
  var zone = zoneAt(px, py);
  var frozenNow = template ? !!template.frozen : false;
  var node = {
    x: px, y: py,
    rootMidi: pitch.rootMidi, rootName: pitch.rootName, pan: pitch.pan,
    quality: pickQuality(),
    frozen: frozenNow,
    frozenAt: (frozenNow && audioCtx) ? audioCtx.currentTime : null,
    releasing: false, pruned: false,
    hitIndex: 0, lastGain: 1, timerId: null, activeVoices: null,
    sizeScale: 1,
    id: nodeIdCounter++,
    timbre: template ? template.timbre : "pure",
    color: template ? template.color : "triad",
    vibrato: template ? template.vibrato : DEFAULT_VIBRATO,
    reverbSend: template ? template.reverbSend : DEFAULT_REVERB,
    delaySend: template ? template.delaySend : DEFAULT_DELAY,
    stretch: template ? template.stretch : DEFAULT_STRETCH,
    zone: zone,
    zoneBreatheBoost: (zone && zone.kind === "breath") ? zone.strength : 0
  };
  nodes.push(node);
  while (nodes.length > MAX_NODES) {
    // Evict the oldest TONAL, UNLOCKED note — a field recording is
    // deliberate and one at a time (never pushed out silently), and a
    // locked note is a conscious choice to keep it (the guard above has
    // already made sure an unlocked candidate exists).
    var idx = nodes.findIndex(function (n) { return n.kind !== "field" && !n.frozen; });
    if (idx < 0) break;
    var old = nodes[idx];
    nodes.splice(idx, 1);
    old.pruned = true;
    if (editingNode === old) closeNodePanel();
  }
  return node;
}

function commitSpawn(node, dragDistance) {
  trackOnce("first-note");
  var t = clamp(dragDistance / maxDragPx(), 0, 1);
  var gainMult = lerp(0.4, 1.25, t);
  node.sizeScale = lerp(0.6, 1.6, t);
  initAudio();
  resumeAudio();
  hit(node, gainMult);
}

function toggleFreeze(node) {
  if (node.pruned) return;
  if (node.frozen) {
    node.frozen = false;
    node.releasing = true;
    node.hitIndex = 0;
    node.frozenAt = null;
  } else {
    node.frozen = true;
    node.releasing = false;
    node.frozenAt = audioCtx ? audioCtx.currentTime : 0;
  }
}

function toggleAllLocks() {
  var tonal = nodes.filter(function (n) { return !n.pruned && n.kind !== "field" && !n._flightId; }); // aircraft stay locked
  var anyUnlocked = tonal.some(function (n) { return !n.frozen; });
  if (anyUnlocked) {
    tonal.forEach(function (n) {
      if (n.frozen) return;
      n.frozen = true;
      n.releasing = false;
      n.frozenAt = audioCtx ? audioCtx.currentTime : 0;
    });
  } else {
    tonal.forEach(function (n) {
      n.frozen = false;
      n.releasing = true;
      n.hitIndex = 0;
      n.frozenAt = null;
    });
  }
  updateLockAllBtnLabel();
}

// Phone dock: an empty room shows no buttons. "lock all" appears with the
// first note, "drift" once there are two to drift — and they stay once
// shown, so they don't flicker as unlocked notes fade away. Hidden in
// flight mode, where aircraft are always locked and never drift.
var dockLockRevealed = false, dockDriftRevealed = false;
function updateDock() {
  var own = nodes.filter(function (n) { return !n.pruned && n.kind !== "field" && !n._flightId; }).length;
  if (own >= 1) dockLockRevealed = true;
  if (own >= 2) dockDriftRevealed = true;
  var flying = flightIsOn();
  var lock = document.getElementById("dockLockBtn"), drift = document.getElementById("dockDriftBtn");
  var hideLock = !dockLockRevealed || flying, hideDrift = !(dockDriftRevealed || driftActive) || flying;
  if (lock.hidden !== hideLock) lock.hidden = hideLock;
  if (drift.hidden !== hideDrift) drift.hidden = hideDrift;
}

function updateLockAllBtnLabel() {
  var tonal = nodes.filter(function (n) { return !n.pruned && n.kind !== "field" && !n._flightId; }); // aircraft stay locked
  var anyUnlocked = tonal.some(function (n) { return !n.frozen; });
  var label = anyUnlocked ? "lock all" : "unlock all";
  var dockLock = document.getElementById("dockLockBtn");
  if (dockLock.textContent !== label) dockLock.textContent = label;
}

// A fingertip is bigger and less precise than a cursor, and drifting notes
// are moving targets — so on touch screens the reach is a little larger,
// with a floor so small notes stay easy to hit. Where reaches overlap, the
// nearest note wins rather than whichever was placed last.
var TOUCH_HIT_SCALE = 1.25;
var TOUCH_HIT_MIN = 34;

function findNodeAt(px, py) {
  var best = null, bestDist = Infinity;
  for (var i = nodes.length - 1; i >= 0; i--) {
    var n = nodes[i];
    if (n.pruned) continue;
    var dx = n.x - px, dy = n.y - py;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var r = HIT_RADIUS * (n.sizeScale || 1);
    if (IS_TOUCH) r = Math.max(r * TOUCH_HIT_SCALE, TOUCH_HIT_MIN);
    if (dist <= r && dist < bestDist) { best = n; bestDist = dist; }
  }
  return best;
}

function updateCollisions(now) {
  var current = {};
  for (var i = 0; i < nodes.length; i++) {
    var a = nodes[i];
    if (a.pruned) continue;
    for (var j = i + 1; j < nodes.length; j++) {
      var b = nodes[j];
      if (b.pruned) continue;
      // A flight node overlapping another on screen is a projection
      // artifact of the profile view (two real aircraft at different
      // real positions, maybe different altitudes, that just happen to
      // land on the same spot) — not an event. Their paths are real and
      // can't be changed, so the only honest move is to not stage a
      // collision that didn't happen. They blend quietly instead.
      if (a._flightId || b._flightId) continue;
      var dx = a.x - b.x, dy = a.y - b.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var rSum = HIT_RADIUS * (a.sizeScale || 1) + HIT_RADIUS * (b.sizeScale || 1);
      if (dist < rSum * 0.88) {
        var key = a.id + "_" + b.id;
        current[key] = true;
        if (!prevCollisions[key]) triggerCollision(a, b, now);
      }
    }
  }
  prevCollisions = current;
}

function triggerCollision(a, b, now) {
  var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  var rgbA = colorFor(a.quality), rgbB = colorFor(b.quality);
  bursts.push({
    x: mx, y: my, start: now,
    rgb: [(rgbA[0] + rgbB[0]) / 2, (rgbA[1] + rgbB[1]) / 2, (rgbA[2] + rgbB[2]) / 2],
    seed: Math.random() * Math.PI * 2
  });
  playCollisionChime(mx);
}

function clearAllNodes() {
  nodes.forEach(function (n) {
    n.pruned = true;
    if (n.timerId) clearTimeout(n.timerId);
    if (n.stopField) n.stopField();
  });
  nodes = [];
  bursts = [];
  prevCollisions = {};
  fieldNode = null;
  closeNodePanel();
}
