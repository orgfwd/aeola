"use strict";

// Drift wanders between the four hand-pickable timbres only — the airport
// voices belong to flight mode.
var DRIFT_TIMBRES = ["pure", "warm", "resonant", "nasal"];

// ── Drift — every note (locked or not — an unlocked note only lives a
// few pulses anyway, too briefly to be worth animating) wanders slowly
// on its own randomized heading, retuning itself for free through the
// exact same position->pitch pipeline manual dragging already uses.
// Timbre and tonal color drift too, on their own much slower random
// clock — mutating them doesn't need to be timed to a note's next
// retrigger to avoid a glitch: the CURRENT voice already captured the
// old values when it started, so a change only ever becomes audible
// at the next natural hit() anyway.
var driftActive = false;
var driftLastFrameAt = null;
var DRIFT_SPEED = 7; // px/sec — slow
var DRIFT_TURN_RATE = 0.5; // max radians/sec heading change
var DRIFT_EDGE_MARGIN = 30;
// Manual dragging stays snappy (the 0.12s default) since you expect
// pitch to track your finger immediately. Drift crosses the same
// column boundaries but should glide between them instead of
// snapping — a longer ramp, retriggered every frame toward a
// constantly-shifting target, smooths the jump into an elegant
// portamento rather than a click.
var DRIFT_PITCH_GLIDE = 0.45;

function pickDifferentFrom(list, current) {
  if (list.length < 2) return current;
  var next;
  do { next = list[Math.floor(Math.random() * list.length)]; } while (next === current);
  return next;
}

function updateDrift(now) {
  if (!driftActive) return;
  if (driftLastFrameAt == null) { driftLastFrameAt = now; return; }
  var dt = (now - driftLastFrameAt) / 1000;
  driftLastFrameAt = now;
  if (dt <= 0 || dt > 0.5) return; // tab was backgrounded or similar — skip one frame rather than lurch

  nodes.forEach(function (n) {
    if (n.pruned || n.kind === "field" || n._flightId) return;
    if (activeDrag && activeDrag.node === n) return; // a manual drag always wins in the moment

    if (n._driftAngle == null) n._driftAngle = Math.random() * Math.PI * 2;
    n._driftAngle += (Math.random() - 0.5) * DRIFT_TURN_RATE * dt;
    var nx = n.x + Math.cos(n._driftAngle) * DRIFT_SPEED * dt;
    var ny = n.y + Math.sin(n._driftAngle) * DRIFT_SPEED * dt;
    if (nx < DRIFT_EDGE_MARGIN || nx > W - DRIFT_EDGE_MARGIN) n._driftAngle = Math.PI - n._driftAngle;
    if (ny < DRIFT_EDGE_MARGIN || ny > H - DRIFT_EDGE_MARGIN) n._driftAngle = -n._driftAngle;
    nx = clamp(nx, DRIFT_EDGE_MARGIN, W - DRIFT_EDGE_MARGIN);
    ny = clamp(ny, DRIFT_EDGE_MARGIN, H - DRIFT_EDGE_MARGIN);
    updateNodePosition(n, nx, ny, DRIFT_PITCH_GLIDE);

    if (n._driftNextEvolveAt == null) n._driftNextEvolveAt = now + 15000 + Math.random() * 15000;
    if (now >= n._driftNextEvolveAt) {
      if (Math.random() < 0.5) n.timbre = pickDifferentFrom(DRIFT_TIMBRES, n.timbre);
      else n.color = pickDifferentFrom(SHARE_COLORS, n.color);
      n._driftNextEvolveAt = now + 15000 + Math.random() * 15000;
    }
  });
}

var ICON_PLAY = '<svg class="btn-icon" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z"/></svg>';
var ICON_PAUSE = '<svg class="btn-icon" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1" width="2.6" height="8"/><rect x="5.9" y="1" width="2.6" height="8"/></svg>';

// The dock's drift button shows a green ▶
// while resting — something will happen — and ❚❚ while drifting.
function updateDriftButtons() {
  ["dockDriftBtn"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.innerHTML = (driftActive ? ICON_PAUSE : ICON_PLAY) + "drift";
    btn.classList.toggle("drifting", driftActive);
  });
}

function toggleDrift() {
  driftActive = !driftActive;
  driftLastFrameAt = null;
  updateDriftButtons();
  if (driftActive) track("drift-started");
}
