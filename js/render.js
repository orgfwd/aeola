"use strict";

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function colorFor(quality) {
  if (quality === "field") return [195, 200, 210];
  return quality === "major" ? [255, 179, 102] : [122, 166, 255];
}

// Isogons — lines of equal magnetic declination on an aeronautical
// chart — reimagined as slow, precise contour lines instead of the
// soft glowing mesh blobs the room used to have. Same idea (a living,
// drifting backdrop) rendered as thin instrument-panel linework
// instead of nebula haze.
var CONTOUR_LINES = [
  { baseY: 0.15, amp: 0.05, freq: 2.1, speed: 0.006, phase: 0,   rgb: [110, 214, 160] },
  { baseY: 0.32, amp: 0.04, freq: 1.6, speed: 0.005, phase: 1.4, rgb: [110, 214, 160] },
  { baseY: 0.50, amp: 0.06, freq: 2.4, speed: 0.007, phase: 2.6, rgb: [224, 168, 84] },
  { baseY: 0.68, amp: 0.045, freq: 1.8, speed: 0.0045, phase: 3.7, rgb: [110, 214, 160] },
  { baseY: 0.85, amp: 0.05, freq: 2.0, speed: 0.006, phase: 5.0, rgb: [224, 168, 84] }
];

function drawBackground(now) {
  var grad = c2d.createRadialGradient(W * 0.5, H * 0.4, 0, W * 0.5, H * 0.4, Math.max(W, H) * 0.8);
  grad.addColorStop(0, "#1a232b");
  grad.addColorStop(0.6, "#121a20");
  grad.addColorStop(1, "#0b1116");
  c2d.fillStyle = grad;
  c2d.fillRect(0, 0, W, H);

  var t = now / 1000;
  c2d.globalCompositeOperation = "lighter";
  var steps = 48;
  CONTOUR_LINES.forEach(function (line) {
    var drift = line.speed * t + line.phase;
    c2d.beginPath();
    for (var i = 0; i <= steps; i++) {
      var xFrac = i / steps;
      var x = xFrac * W;
      var y = (line.baseY + Math.sin(xFrac * Math.PI * line.freq + drift) * line.amp) * H;
      if (i === 0) c2d.moveTo(x, y); else c2d.lineTo(x, y);
    }
    var alpha = Math.max(0.05, 0.11 + Math.sin(drift * 0.7) * 0.03);
    c2d.strokeStyle = "rgba(" + line.rgb.join(",") + "," + alpha + ")";
    c2d.lineWidth = 1;
    c2d.stroke();
  });
  c2d.globalCompositeOperation = "source-over";
}

var pointerPos = null;
function drawCursorGlow() {
  if (!pointerPos) return;
  var r = 60;
  var g = c2d.createRadialGradient(pointerPos.x, pointerPos.y, 0, pointerPos.x, pointerPos.y, r);
  g.addColorStop(0, "rgba(110, 214, 160, 0.10)");
  g.addColorStop(1, "rgba(110, 214, 160, 0)");
  c2d.globalCompositeOperation = "lighter";
  c2d.fillStyle = g;
  c2d.beginPath();
  c2d.arc(pointerPos.x, pointerPos.y, r, 0, Math.PI * 2);
  c2d.fill();
  c2d.globalCompositeOperation = "source-over";
}

function drawGrid() {
  if (!gridVisible) return;
  var notes = activeNotes();
  c2d.save();
  c2d.strokeStyle = "rgba(200, 205, 245, 0.26)";
  c2d.lineWidth = 1;
  c2d.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
  c2d.textAlign = "center";
  c2d.fillStyle = "rgba(210, 215, 245, 0.75)";

  for (var i = 0; i <= notes.length; i++) {
    var x = (i / notes.length) * W;
    c2d.beginPath();
    c2d.moveTo(x, 0);
    c2d.lineTo(x, H);
    c2d.stroke();
  }
  notes.forEach(function (note, i) {
    var cx = ((i + 0.5) / notes.length) * W;
    c2d.fillText(note.name, cx, H - 86); // above the dock buttons, which sit on the bottom edge
  });

  [0.33, 0.66].forEach(function (f) {
    var y = f * H;
    c2d.beginPath();
    c2d.moveTo(0, y);
    c2d.lineTo(W, y);
    c2d.stroke();
  });
  c2d.restore();
}

function drawHeldMarkers() {
  // frozenAt is in audioCtx.currentTime (seconds), the same clock
  // computeBreath() uses for the sound's breathing — not performance.now(),
  // which has a different epoch and scale.
  var audioNow = audioCtx ? audioCtx.currentTime : 0;
  var nowMs = performance.now();
  nodes.forEach(function (n) {
    if (n.pruned || !n.frozen) return;
    var appear = nodeAppear(n, nowMs);
    if (appear <= 0) return;
    var rgb = colorFor(n.quality);
    var elapsed = n.frozenAt != null ? audioNow - n.frozenAt : 0;
    var breathe = 0.5 + 0.5 * Math.sin((elapsed / BREATHE_VIBRATO_PERIOD) * Math.PI * 2 + n.id);
    var baseR = 9 * (n.sizeScale || 1) * (0.5 + 0.5 * appear);
    var glowR = baseR * (2.1 + breathe * 0.6);

    c2d.globalCompositeOperation = "lighter";
    var glow = c2d.createRadialGradient(n.x, n.y, 0, n.x, n.y, glowR);
    glow.addColorStop(0, "rgba(" + rgb.join(",") + "," + ((0.14 + breathe * 0.1) * appear) + ")");
    glow.addColorStop(1, "rgba(" + rgb.join(",") + ",0)");
    c2d.fillStyle = glow;
    c2d.beginPath();
    c2d.arc(n.x, n.y, glowR, 0, Math.PI * 2);
    c2d.fill();
    c2d.globalCompositeOperation = "source-over";

    c2d.beginPath();
    c2d.arc(n.x, n.y, baseR, 0, Math.PI * 2);
    c2d.strokeStyle = "rgba(" + rgb.join(",") + "," + ((0.65 + breathe * 0.2) * appear) + ")";
    c2d.lineWidth = 2;
    c2d.stroke();
  });
}

function drawHoverOutline() {
  if (!pointerPos || activeDrag) return;
  var n = findNodeAt(pointerPos.x, pointerPos.y);
  if (!n) return;
  var r = HIT_RADIUS * (n.sizeScale || 1) + 10;
  c2d.save();
  c2d.setLineDash([5, 5]);
  c2d.lineWidth = 1.5;
  c2d.strokeStyle = "rgba(230, 233, 255, 0.55)";
  c2d.beginPath();
  c2d.arc(n.x, n.y, r, 0, Math.PI * 2);
  c2d.stroke();
  c2d.restore();
}

function drawPendingPreview() {
  if (!activeDrag || !activeDrag.justSpawned || activeDrag.node.pruned) return;
  var node = activeDrag.node;
  var dx = (pointerPos ? pointerPos.x : node.x) - activeDrag.startX;
  var dy = (pointerPos ? pointerPos.y : node.y) - activeDrag.startY;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var t = clamp(dist / maxDragPx(), 0, 1);
  var radius = lerp(8, 34, t);
  var rgb = colorFor(node.quality);
  c2d.globalCompositeOperation = "lighter";
  var g = c2d.createRadialGradient(node.x, node.y, 0, node.x, node.y, radius);
  g.addColorStop(0, "rgba(" + rgb.join(",") + "," + lerp(0.18, 0.4, t) + ")");
  g.addColorStop(1, "rgba(" + rgb.join(",") + ",0)");
  c2d.fillStyle = g;
  c2d.beginPath();
  c2d.arc(node.x, node.y, radius, 0, Math.PI * 2);
  c2d.fill();
  c2d.globalCompositeOperation = "source-over";
  c2d.beginPath();
  c2d.arc(node.x, node.y, Math.max(3, radius * 0.3), 0, Math.PI * 2);
  c2d.strokeStyle = "rgba(" + rgb.join(",") + ",0.7)";
  c2d.lineWidth = 1.5;
  c2d.stroke();
}

function drawBursts(now) {
  bursts = bursts.filter(function (b) {
    var elapsed = (now - b.start) / 1000;
    if (elapsed > 0.6) return false;
    var t = elapsed / 0.6;
    var radius = lerp(4, 70, easeOutCubic(t));
    var alpha = (1 - t) * 0.8;

    var g = c2d.createRadialGradient(b.x, b.y, 0, b.x, b.y, radius);
    g.addColorStop(0, "rgba(255,255,255," + (alpha * 0.9) + ")");
    g.addColorStop(0.4, "rgba(" + b.rgb.join(",") + "," + (alpha * 0.6) + ")");
    g.addColorStop(1, "rgba(" + b.rgb.join(",") + ",0)");
    c2d.fillStyle = g;
    c2d.beginPath();
    c2d.arc(b.x, b.y, radius, 0, Math.PI * 2);
    c2d.fill();

    var sparkCount = 6;
    for (var i = 0; i < sparkCount; i++) {
      var ang = (i / sparkCount) * Math.PI * 2 + b.seed;
      var sr = radius * 0.9;
      var px = b.x + Math.cos(ang) * sr, py = b.y + Math.sin(ang) * sr;
      c2d.beginPath();
      c2d.arc(px, py, Math.max(1, 3 * (1 - t)), 0, Math.PI * 2);
      c2d.fillStyle = "rgba(255,255,255," + alpha + ")";
      c2d.fill();
    }
    return true;
  });
}

function draw() {
  var now = performance.now();
  drawBackground(now);
  drawCursorGlow();
  drawGrid();
  drawHeldMarkers();
  updateSynchroscope(now);
  drawSynchroscope(now);
  updateLockAllBtnLabel();
  updateDock();
  updateCoach(now);
  updateDrift(now);
  updateFlightMotion(now);
  drawFlightLabels();
  drawHoverOutline();
  drawPendingPreview();
  updateCollisions(now);

  c2d.globalCompositeOperation = "lighter";
  ripples = ripples.filter(function (r) {
    var s = r.stretch || 1;
    var rAttack = ATTACK * s, rSustain = SUSTAIN * s, rRelease = RELEASE * s, rTotal = rAttack + rSustain + rRelease;
    var elapsed = (now - r.start) / 1000;
    if (elapsed > rTotal + 0.3) return false;

    var growPhase = Math.min(1, elapsed / (rAttack + rSustain * 0.6));
    var radius = (14 + easeOutCubic(growPhase) * 170) * (r.sizeScale || 1);

    var alpha;
    if (elapsed < rAttack) {
      alpha = (elapsed / rAttack);
    } else if (elapsed < rAttack + rSustain) {
      alpha = 1;
    } else {
      alpha = Math.max(0, 1 - (elapsed - rAttack - rSustain) / rRelease);
    }
    alpha *= 0.5 * r.peak;

    var rgb = colorFor(r.quality);
    var grad = c2d.createRadialGradient(r.x, r.y, 0, r.x, r.y, radius);
    grad.addColorStop(0, "rgba(" + rgb.join(",") + "," + alpha + ")");
    grad.addColorStop(1, "rgba(" + rgb.join(",") + ",0)");
    c2d.fillStyle = grad;
    c2d.beginPath();
    c2d.arc(r.x, r.y, radius, 0, Math.PI * 2);
    c2d.fill();

    if (revealEnabled) {
      var labelWindowStart = rAttack * 0.7;
      var labelWindowEnd = rTotal - 0.3;
      if (elapsed > labelWindowStart && elapsed < labelWindowEnd) {
        var lp = (elapsed - labelWindowStart) / (labelWindowEnd - labelWindowStart);
        var labelAlpha = Math.sin(Math.min(1, lp) * Math.PI) * 0.9 * Math.max(0.6, r.peak);
        c2d.globalCompositeOperation = "source-over";
        c2d.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
        c2d.textAlign = "center";
        c2d.fillStyle = "rgba(235, 238, 255," + labelAlpha + ")";
        c2d.fillText(r.rootName + " " + r.quality, r.x, r.y - radius - 10);
        c2d.globalCompositeOperation = "lighter";
      }
    }

    return true;
  });

  drawBursts(now);
  c2d.globalCompositeOperation = "source-over";

  requestAnimationFrame(draw);
}
