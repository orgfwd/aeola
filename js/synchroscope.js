"use strict";

// ── Synchroscope — makes beating visible.
//
// Twin-engine pilots sync their propellers by ear: two engines a few RPM
// apart produce a slow "wah-wah" throb, and the cockpit instrument for it
// — a synchroscope — is a little disc that spins while the engines are out
// of sync and stands still when they match. Two musical notes do exactly
// the same thing. Every note is a stack of harmonics (whole-number
// multiples of its pitch); wherever a harmonic of one note lands CLOSE to
// a harmonic of another, the two throb against each other at the
// difference between their frequencies. Land exactly on it and the throb
// stops — that is what "consonant" physically means.
//
// Nothing here changes the sound. It reads the frequencies the voices are
// actually playing (including glides, drift and each drone's breathing),
// models their harmonics from the timbre's oscillator shape and filter,
// and draws what the ear is already hearing:
//
//   - between two notes, a disc spinning at the real beat rate (one turn
//     per throb), in the direction of whichever note is sharp;
//   - around a single chord, a slow dashed ring when its own tones beat
//     against each other (magnetic north) — still and fading under true
//     north, where the chord's ratios are pure;
//   - "turbulence" when two harmonics are too far apart to throb and too
//     close to fuse: roughness, the physical texture of dissonance.
//
// Dissonance is never corrected, only shown. Tension is part of the room.

var SYNC_TICK_MS = 60;          // analysis rate; drawing still runs every frame
var BEAT_MIN_HZ = 0.25;         // slower than one throb per 4s reads as locked
var BEAT_MAX_HZ = 14;           // faster than this the ear hears roughness, not a throb
var SYNC_MAX_HARMONIC = 8;
var SYNC_PARTIAL_CEILING_HZ = 5000;
var SYNC_VISUAL_MAX_REV = 3;    // the disc tops out here; faster beats blur instead
var SYNC_SHOW_THRESHOLD = 0.02;
// Brightness follows how present each note is:
//   - a LOCKED note is a drone that's always there, so connectors between
//     locked notes hold steady at SYNC_BASELINE, beating or not — a still
//     green disc is information too: "in sync";
//   - an UNLOCKED note comes and goes, so any connector touching one pulses
//     with its sound (envelopeAt);
//   - in FLIGHT mode everything pulses with the sound and only the
//     SYNC_MAX_PAIRS strongest pairs are drawn: eight aircraft means 28
//     pairs, and a sky that busy stops being calm. Pairs already showing are
//     favoured (SYNC_HOLD_BONUS) so they don't flicker as rankings trade.
var SYNC_BASELINE = 0.45;
var SYNC_MAX_PAIRS = 4;
var SYNC_HOLD_BONUS = 1.3;

function notePresence(node, t) {
  if (node.frozen && !flightIsOn()) return 1;
  return envelopeAt(node, t);
}

// How loud a note is right now, mirroring scheduleEnvelope().
function envelopeAt(node, t) {
  if (node.lastHitStart == null) return 0;
  var s = node.lastStretch || node.stretch || 1;
  var e = t - node.lastHitStart;
  var a = ATTACK * s, sus = SUSTAIN * s, r = RELEASE * s;
  var level = 0;
  if (e < 0) level = 0;
  else if (e < a) level = e / a;
  else if (e < a + sus) level = 1;
  else if (e < a + sus + r) level = 1 - (e - a - sus) / r;
  return level * clamp(node.lastGain || 0.85, 0, 1);
}
// Roughness below ROUGH_FLOOR is the ordinary grain of any two notes in
// this register (a sine major third at middle C sits around 0.4) — left
// unshaken. It builds to full turbulence at ROUGH_FULL (seconds sit at
// 0.6–1). Calibrated against intervals of every timbre at middle C.
var ROUGH_FLOOR = 0.35, ROUGH_FULL = 0.85, ROUGH_TURBULENT = 0.6;

var SYNC_BEAT_RGB = [224, 168, 84];    // amber — the instrument-panel warning tone
var SYNC_LOCKED_RGB = [110, 214, 160]; // green — the panel's "all good"
var SYNC_ROUGH_RGB = [235, 120, 140];  // rose — same as the snapshot's restless tint

var syncPairs = {};   // "idA_idB" -> smoothed state for a pair of notes
var syncChords = {};  // node id -> smoothed state for a chord's own tones
var syncLastTickAt = 0;
var syncLastFrameAt = null;

function syncPairKey(idA, idB) {
  return idA < idB ? idA + "_" + idB : idB + "_" + idA;
}

// A voice's pitch right now, following any glide still in progress.
function voiceFreqAt(v, t) {
  if (v.glideT1 != null && t < v.glideT1 && v.glideT1 > v.glideT0) {
    return lerp(v.glideFrom, v.freq, clamp((t - v.glideT0) / (v.glideT1 - v.glideT0), 0, 1));
  }
  return v.freq;
}

// Magnitude of a Web Audio biquad at frequency f — the standard analog
// prototypes, close enough to decide which harmonics survive the filter.
function filterGainAt(type, fc, q, f) {
  if (type === "allpass" || !fc) return 1;
  var x = f / fc, a = 1 - x * x, b = x / (q || 0.707);
  var den = Math.sqrt(a * a + b * b) || 1e-6;
  if (type === "lowpass") return 1 / den;
  if (type === "highpass") return (x * x) / den;
  if (type === "bandpass") return b / den;
  return 1;
}

// The harmonics a voice is actually putting out: a sine is a single
// partial, a sawtooth every harmonic at 1/k, a triangle only the odd ones
// at 1/k², plus the timbre's sub an octave down — then shaped by the
// timbre's filter. Normalised so the loudest partial is 1.
function voicePartials(v, t) {
  var cfg = TIMBRE_CONFIG[v.timbre] || TIMBRE_CONFIG.pure;
  var f0 = voiceFreqAt(v, t) * Math.pow(2, (v.wobble || 0) / 1200);
  var fc = timbreFilterFreq(v.timbre, f0);
  var raw = [];
  for (var k = 1; k <= SYNC_MAX_HARMONIC; k++) {
    var amp;
    if (cfg.oscType === "sine") amp = k === 1 ? 1 : 0;
    else if (cfg.oscType === "triangle") amp = k % 2 ? 1 / (k * k) : 0;
    else amp = 1 / k;
    if (!amp || f0 * k > SYNC_PARTIAL_CEILING_HZ) continue;
    raw.push({ f: f0 * k, a: amp * filterGainAt(cfg.filterType, fc, cfg.filterQ, f0 * k) });
  }
  if (cfg.sub) raw.push({ f: f0 / 2, a: 0.5 * filterGainAt(cfg.filterType, fc, cfg.filterQ, f0 / 2) });
  var peak = 0;
  raw.forEach(function (p) { if (p.a > peak) peak = p.a; });
  if (!peak) return [];
  return raw.filter(function (p) { return p.a > peak * 0.04; })
    .map(function (p) { return { f: p.f, a: p.a / peak }; });
}

// Every harmonic of one set against every harmonic of the other. A beat's
// depth is set by the quieter of the two partials, so that's its weight.
function comparePartials(pa, pb) {
  var out = { rate: 0, dir: 1, beat: 0, rough: 0, locked: 0 };
  var energyA = 0, energyB = 0;
  pa.forEach(function (p) { energyA += p.a * p.a; });
  pb.forEach(function (p) { energyB += p.a * p.a; });
  for (var i = 0; i < pa.length; i++) {
    for (var j = 0; j < pb.length; j++) {
      var fa = pa[i].f, fb = pb[j].f;
      var d = Math.abs(fa - fb);
      var w = Math.min(pa[i].a, pb[j].a);
      if (d < BEAT_MIN_HZ) {
        out.locked += w;
      } else if (d < BEAT_MAX_HZ) {
        if (w > out.beat) { out.beat = w; out.rate = d; out.dir = fa > fb ? 1 : -1; }
      } else {
        out.rough += pa[i].a * pb[j].a * roughnessCurve(d, Math.min(fa, fb));
      }
    }
  }
  // Relative to the two sounds' total energy, so a harmonically rich
  // timbre isn't judged rougher merely for having more partials to count.
  out.rough = energyA && energyB ? Math.min(1, out.rough / Math.sqrt(energyA * energyB)) : 0;
  return out;
}

// Plomp & Levelt's roughness curve, in Sethares' closed form: two tones
// clash hardest when they're about a quarter of a critical band apart
// (~30 Hz around middle C) and fuse again once they're a full band apart.
// Normalised so the worst case is 1.
function roughnessCurve(d, fLow) {
  var x = 0.24 * d / (0.021 * fLow + 19);
  return (Math.exp(-3.5 * x) - Math.exp(-5.75 * x)) / 0.1807;
}

function analyseSync() {
  var t = audioCtx.currentTime;
  var sounding = [];
  nodes.forEach(function (n) {
    if (n.pruned || n.kind === "field" || !n.activeVoices) return;
    var perVoice = n.activeVoices.map(function (v) { return voicePartials(v, t); });
    sounding.push({ node: n, env: notePresence(n, t), perVoice: perVoice, all: [].concat.apply([], perVoice) });
  });

  var livePairs = {}, liveChords = {};
  sounding.forEach(function (s) {
    var best = { rate: 0, dir: 1, beat: 0, rough: 0, locked: 0 };
    for (var i = 0; i < s.perVoice.length; i++) {
      for (var j = i + 1; j < s.perVoice.length; j++) {
        var r = comparePartials(s.perVoice[i], s.perVoice[j]);
        if (r.beat > best.beat) { best.beat = r.beat; best.rate = r.rate; best.dir = r.dir; }
        best.rough = Math.max(best.rough, r.rough);
      }
    }
    var st = syncChords[s.node.id] || (syncChords[s.node.id] = newSyncState());
    st.target = best;
    st.presence = s.env;
    liveChords[s.node.id] = true;
  });

  for (var i = 0; i < sounding.length; i++) {
    for (var j = i + 1; j < sounding.length; j++) {
      var a = sounding[i], b = sounding[j];
      // Keep the direction convention stable: always lower id vs higher id.
      if (a.node.id > b.node.id) { var tmp = a; a = b; b = tmp; }
      var key = syncPairKey(a.node.id, b.node.id);
      var st = syncPairs[key] || (syncPairs[key] = newSyncState());
      st.target = comparePartials(a.all, b.all);
      st.presence = Math.min(a.env, b.env);
      st.a = a.node; st.b = b.node;
      livePairs[key] = true;
    }
  }

  // Anything no longer sounding fades on its own; forget it once invisible.
  Object.keys(syncPairs).forEach(function (k) {
    if (!livePairs[k]) {
      syncPairs[k].presence = 0;
      if (syncPairs[k].strength < 0.005 || !syncPairs[k].a || syncPairs[k].a.pruned || syncPairs[k].b.pruned) delete syncPairs[k];
    }
  });
  Object.keys(syncChords).forEach(function (k) {
    if (!liveChords[k]) {
      syncChords[k].presence = 0;
      if (syncChords[k].strength < 0.005) delete syncChords[k];
    }
  });
}

function newSyncState() {
  return { target: null, presence: 0, rate: 0, dir: 1, strength: 0, rough: 0, visible: 0, phase: Math.random() * Math.PI * 2 };
}

// Ease every displayed value toward its target, so a beat that slows to
// a stop is SEEN slowing to a stop, and the disc lingers a moment in green
// once it locks before fading away.
function smoothSyncState(st, dt, beatOnly) {
  var tg = st.target || { rate: 0, beat: 0, rough: 0, dir: 1 };
  var beating = tg.beat * st.presence;
  var rough = beatOnly ? 0 : clamp((tg.rough - ROUGH_FLOOR) / (ROUGH_FULL - ROUGH_FLOOR), 0, 1) * st.presence;
  var baseline = beatOnly ? 0 : SYNC_BASELINE * st.presence;
  var targetRate = tg.beat > 0.02 ? tg.rate : 0;
  st.rate += (targetRate - st.rate) * Math.min(1, dt * 2.5);
  if (tg.beat > 0.02) st.dir = tg.dir;
  var targetStrength = Math.max(beating, rough, baseline);
  // Rises fast, falls a little slower — quick enough that a connector to an
  // unlocked note visibly breathes with each strike.
  var k = targetStrength > st.strength ? dt * 2.2 : dt * 1.3;
  st.strength += (targetStrength - st.strength) * Math.min(1, k);
  st.rough += (rough - st.rough) * Math.min(1, dt * 2);
  st.phase += st.dir * Math.min(st.rate, SYNC_VISUAL_MAX_REV) * dt * Math.PI * 2;
}

function updateSynchroscope(nowMs) {
  if (!audioCtx) return;
  if (nowMs - syncLastTickAt > SYNC_TICK_MS) {
    syncLastTickAt = nowMs;
    analyseSync();
  }
  var dt = syncLastFrameAt == null ? 0 : (nowMs - syncLastFrameAt) / 1000;
  syncLastFrameAt = nowMs;
  if (dt <= 0 || dt > 0.5) return;
  Object.keys(syncPairs).forEach(function (k) { smoothSyncState(syncPairs[k], dt, false); });
  // A chord's ring is about beating only — so "the ring stops under true
  // north" stays a clean signal. Roughness belongs to the pair lines.
  Object.keys(syncChords).forEach(function (k) { smoothSyncState(syncChords[k], dt, true); });

  // Outside flight mode every pair is drawn; in flight mode only the
  // strongest few. Either way a connector fades in and out gently.
  var ranked = Object.keys(syncPairs).map(function (k) { return syncPairs[k]; })
    .filter(function (st) { return st.strength >= SYNC_SHOW_THRESHOLD; })
    .sort(function (p, q) {
      return q.strength * (q.visible > 0.5 ? SYNC_HOLD_BONUS : 1) - p.strength * (p.visible > 0.5 ? SYNC_HOLD_BONUS : 1);
    });
  var chosen = flightIsOn() ? ranked.slice(0, SYNC_MAX_PAIRS) : ranked;
  Object.keys(syncPairs).forEach(function (k) {
    var st = syncPairs[k];
    var want = chosen.indexOf(st) !== -1 ? 1 : 0;
    st.visible += (want - st.visible) * Math.min(1, dt * 1.5);
  });
}

// Amber while throbbing, easing to green as the throb slows toward a lock,
// rose where roughness dominates.
function syncColor(st) {
  var calm = 1 - clamp(st.rate / 1.5, 0, 1);
  var rgb = mixRgb(SYNC_BEAT_RGB, SYNC_LOCKED_RGB, calm);
  var roughShare = st.strength > 0 ? clamp(st.rough / st.strength, 0, 1) : 0;
  return mixRgb(rgb, SYNC_ROUGH_RGB, roughShare);
}

function drawSynchroscope(nowMs) {
  c2d.save();
  var jitterSeed = Math.floor(nowMs / 70); // turbulence re-shakes ~14 times a second

  Object.keys(syncPairs).forEach(function (k) {
    var st = syncPairs[k];
    if (st.strength < SYNC_SHOW_THRESHOLD || st.visible < 0.02 || !st.a || !st.b || st.a.pruned || st.b.pruned) return;
    var nowMs = performance.now();
    var s = clamp(st.strength, 0, 1) * st.visible * Math.min(nodeAppear(st.a, nowMs), nodeAppear(st.b, nowMs));
    var rgb = syncColor(st);
    var ax = st.a.x, ay = st.a.y, bx = st.b.x, by = st.b.y;
    var dx = bx - ax, dy = by - ay;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    var nx = -dy / len, ny = dx / len;
    var roughShare = clamp(st.rough / st.strength, 0, 1);

    // The line between the two notes — shaken where the air is rough.
    c2d.beginPath();
    var segs = 14;
    for (var i = 0; i <= segs; i++) {
      var f = i / segs;
      var shake = 0;
      if (roughShare > 0.1 && i > 0 && i < segs) {
        var r = Math.sin((jitterSeed * 12.9898 + i * 78.233 + st.phase) * 43758.5453);
        shake = (r - Math.floor(r) - 0.5) * 5 * roughShare * s;
      }
      var px = ax + dx * f + nx * shake, py = ay + dy * f + ny * shake;
      if (i === 0) c2d.moveTo(px, py); else c2d.lineTo(px, py);
    }
    c2d.strokeStyle = "rgba(" + rgb.join(",") + "," + (0.45 * s) + ")";
    c2d.lineWidth = 1.25;
    c2d.stroke();

    // The disc itself, at the midpoint — skipped when the notes sit so
    // close together it would land on top of them.
    if (len < 56) return;
    var cx = ax + dx * 0.5, cy = ay + dy * 0.5;
    var radius = 7;
    c2d.beginPath();
    c2d.arc(cx, cy, radius, 0, Math.PI * 2);
    c2d.fillStyle = "rgba(8, 11, 14, " + (0.55 * s) + ")";
    c2d.fill();
    c2d.strokeStyle = "rgba(" + rgb.join(",") + "," + (0.9 * s) + ")";
    c2d.lineWidth = 1.25;
    c2d.stroke();

    // Beats faster than the disc can honestly show leave a ghosted blur
    // behind the blades, the way a real prop disc smears at speed.
    var blur = clamp((st.rate - SYNC_VISUAL_MAX_REV) / 6, 0, 1);
    var blades = blur > 0 ? [0, -0.35, -0.7] : [0];
    blades.forEach(function (lag, bi) {
      var ang = st.phase + lag;
      var bAlpha = (bi === 0 ? 1 : 0.4 * blur) * s;
      c2d.beginPath();
      c2d.moveTo(cx - Math.cos(ang) * (radius - 1.5), cy - Math.sin(ang) * (radius - 1.5));
      c2d.lineTo(cx + Math.cos(ang) * (radius - 1.5), cy + Math.sin(ang) * (radius - 1.5));
      c2d.strokeStyle = "rgba(" + rgb.join(",") + "," + bAlpha + ")";
      c2d.lineWidth = 1.5;
      c2d.stroke();
    });
  });

  // A chord's own tones beating against each other: a slow dashed ring.
  nodes.forEach(function (n) {
    var st = syncChords[n.id];
    if (!st || n.pruned || st.strength < SYNC_SHOW_THRESHOLD) return;
    var s = clamp(st.strength, 0, 1) * nodeAppear(n, performance.now());
    var rgb = syncColor(st);
    var r = 17 * (n.sizeScale || 1);
    c2d.beginPath();
    c2d.arc(n.x, n.y, r, 0, Math.PI * 2);
    c2d.setLineDash([2, 5]);
    c2d.lineDashOffset = -st.phase * r;
    c2d.strokeStyle = "rgba(" + rgb.join(",") + "," + (0.8 * s) + ")";
    c2d.lineWidth = 1.25;
    c2d.stroke();
    c2d.setLineDash([]);
  });

  c2d.restore();
}

// Plain-language reading of a pair for the snapshot panel, from the raw
// physics (not the envelope-scaled display), so it doesn't flicker to
// nothing in the quiet gap between a drone's retriggers.
function syncReading(idA, idB) {
  var st = syncPairs[syncPairKey(idA, idB)];
  if (!st || !st.target) return null;
  var tg = st.target;
  var turbulent = tg.rough >= ROUGH_TURBULENT;
  var base = null;
  if (tg.beat > 0.05) base = "beating " + tg.rate.toFixed(1) + "×/s";
  else if (tg.locked > 0.05 && !turbulent) base = "in sync";
  if (turbulent) return base ? base + ", turbulent" : "turbulent";
  return base;
}
