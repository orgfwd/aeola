"use strict";

function colorIntervals(color, quality) {
  var third = quality === "major" ? 4 : 3;
  switch (color) {
    case "add9": return [0, third, 7, 14];
    case "sus4": return [0, 5, 7];
    case "open5th": return [0, 7, 12];
    default: return [0, third, 7];
  }
}

var INTERVAL_NAMES = ["unison", "minor 2nd", "major 2nd", "minor 3rd", "major 3rd", "perfect 4th", "tritone", "perfect 5th", "minor 6th", "major 6th", "minor 7th", "major 7th"];

// One line per interval, indices matching INTERVAL_NAMES — shown only
// when a relationship line is tapped, never by default.
var INTERVAL_INSIGHTS = [
  "same note, doubled — the simplest possible relationship.",
  "the sharpest clash in the scale — used sparingly, it demands resolution.",
  "an open, walking distance — common in melody, rarely restful.",
  "a small, wistful gap — the backbone of minor-key sound.",
  "a bright, confident gap — the backbone of major-key sound.",
  "one of the most stable intervals after the octave — steady, unshowy.",
  "exactly half an octave — historically called \"the devil in music\" for its restlessness.",
  "the most stable interval after the octave — this is why power chords use it.",
  "a dark, brooding gap — often the emotional center of a minor chord.",
  "an open, hopeful gap — often the emotional center of a major chord.",
  "a bluesy, unresolved distance — wants to fall a step further.",
  "one step short of the octave — one of the most tension-filled intervals there is."
];

// Rough perceptual dissonance per semitone (0 = unison, calm; 1 = most
// restless) — a judgment call, not a physics measurement, used only to
// tint the "notes sounding" header, never shown as a number or a score.
var TENSION_BY_SEMITONE = [0, 0.95, 0.5, 0.25, 0.2, 0.15, 0.85, 0.05, 0.3, 0.25, 0.55, 0.9];
function chordTension(pitchClasses) {
  var pairs = 0, sum = 0;
  for (var i = 0; i < pitchClasses.length; i++) {
    for (var j = i + 1; j < pitchClasses.length; j++) {
      var semi = ((pitchClasses[j] - pitchClasses[i]) % 12 + 12) % 12;
      sum += TENSION_BY_SEMITONE[semi];
      pairs++;
    }
  }
  return pairs ? sum / pairs : 0;
}
function snapshotTension(snapNodes) {
  if (!snapNodes.length) return 0;
  var sum = 0;
  snapNodes.forEach(function (n) { sum += chordTension(n.pitchClasses); });
  return sum / snapNodes.length;
}
function mixRgb(a, b, t) {
  return [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * t); });
}

function pitchClassName(pc) {
  return CHROMATIC_NOTES[((pc % 12) + 12) % 12].name;
}

function chordPitchClasses(node) {
  var intervals = colorIntervals(node.color, node.quality);
  return intervals.map(function (semi) {
    return ((node.rootMidi + semi) % 12 + 12) % 12;
  });
}

function colorLabelFor(color) {
  return { triad: "", add9: " +9", sus4: " sus4", open5th: " open 5th" }[color] || "";
}

function chordLabel(node) {
  var label = node.rootName + " " + node.quality + colorLabelFor(node.color);
  if (node.timbre && node.timbre !== "pure") label += " · " + node.timbre;
  return label;
}

// ── North — which tuning the room steers by.
//
// Magnetic north is the practical compass everyone navigates by: equal
// temperament, the piano's tuning, where every semitone is exactly the
// same size. It is close to pure everywhere and exactly pure nowhere but
// the octave — the way a compass needle is close to true north but off
// by a local declination.
//
// True north tunes each chord's own tones to whole-number ratios above
// its root (5:4 for a major third, 3:2 for a fifth...), so the chord's
// overtones land exactly on top of each other and stop beating. Roots
// stay where the grid puts them, so BETWEEN notes the tension stays — and
// a little new tension appears, because a pure third inside one chord no
// longer matches the grid's third as a root of another. No tuning makes
// everything pure at once; that gap is the lesson, not a bug to hide.
var trueNorth = false;

// Pure ratio each chord tone is tuned to under true north, keyed by
// semitones above the root. Only the intervals colorIntervals() can
// produce need an entry; anything else falls back to equal temperament.
var TRUE_NORTH_RATIOS = { 0: 1, 3: 6 / 5, 4: 5 / 4, 5: 4 / 3, 7: 3 / 2, 12: 2, 14: 9 / 4 };

// Under true north each voice also holds steadier: vibrato and the two
// oscillators' chorus detune are scaled down. A pure ratio can only lock
// if the notes hold still long enough for their overtones to line up —
// at full vibrato (±12¢ at the default) the wobble swamps the 2–16¢
// differences the tuning is about. A judgment call, tune by ear.
var TRUE_NORTH_STEADY = 0.3;

function northSteadiness() { return trueNorth ? TRUE_NORTH_STEADY : 1; }

function chordToneFreq(rootMidi, semi) {
  if (trueNorth && TRUE_NORTH_RATIOS[semi] != null) {
    return midiToFreq(rootMidi) * TRUE_NORTH_RATIOS[semi];
  }
  return midiToFreq(rootMidi + semi);
}

// The simple whole-number ratio each interval approximates, indices
// matching INTERVAL_NAMES. The tritone has no simple ratio; 45:32 is the
// conventional pure version, and its size is the point.
var INTERVAL_RATIOS = [[1, 1], [16, 15], [9, 8], [6, 5], [5, 4], [4, 3], [45, 32], [3, 2], [8, 5], [5, 3], [9, 5], [15, 8]];

// Declination: how far magnetic tuning puts an interval from its pure
// ratio, in cents (hundredths of a semitone). Positive = wider than pure.
function intervalDeclination(semi) {
  var r = INTERVAL_RATIOS[semi];
  return semi * 100 - 1200 * Math.log(r[0] / r[1]) / Math.LN2;
}

// One physics sentence per interval, generated from the ratio rather
// than written by hand, so it can't drift out of step with the numbers.
function intervalPhysicsLine(semi) {
  var r = INTERVAL_RATIOS[semi];
  if (semi === 0) return "Pure ratio 1:1 — every harmonic of one note lands on the other's.";
  var ratio = r[0] + ":" + r[1];
  var dec = intervalDeclination(semi);
  var gap = Math.abs(dec).toFixed(0) + "¢ " + (dec > 0 ? "wide" : "narrow");
  var decText;
  if (Math.abs(dec) < 0.5) decText = "Magnetic tuning hits it exactly.";
  else if (trueNorth) decText = "True north tunes it exactly that way inside each chord; magnetic would set it " + gap + ".";
  else decText = "Magnetic tuning sets it " + gap + " of pure — that gap is what beats.";
  if (r[0] + r[1] > 16) {
    return "Pure ratio " + ratio + " — no low harmonics line up, so there is nothing to lock onto. It stays restless in any tuning.";
  }
  return "Pure ratio " + ratio + " — the lower note's harmonic " + r[0] + " meets the upper note's harmonic " + r[1] + ". " + decText;
}
