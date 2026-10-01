"use strict";

function buildSnapshot(activeNodes) {
  var active = activeNodes || nodes.filter(function (n) { return !n.pruned; });
  var tonal = active.filter(function (n) { return n.kind !== "field"; });
  return {
    time: Date.now(),
    hasField: active.some(function (n) { return n.kind === "field"; }),
    nodes: tonal.map(function (n) {
      return {
        id: n.id,
        flight: !!n._flightId,
        rootMidi: n.rootMidi, rootName: n.rootName, quality: n.quality,
        color: n.color, timbre: n.timbre,
        pitchClasses: chordPitchClasses(n),
        // Full state so a reloaded combo resumes the landscape as it was
        // left, not just the notes that were sounding.
        x: n.x, y: n.y, frozen: !!n.frozen,
        vibrato: n.vibrato, reverbSend: n.reverbSend, delaySend: n.delaySend,
        stretch: n.stretch, sizeScale: n.sizeScale || 1,
        lastGain: n.lastGain || 0.85
      };
    })
  };
}

function relationshipsFor(snapNodes) {
  var pairs = [];
  for (var i = 0; i < snapNodes.length; i++) {
    for (var j = i + 1; j < snapNodes.length; j++) {
      var a = snapNodes[i], b = snapNodes[j];
      var semi = ((b.rootMidi - a.rootMidi) % 12 + 12) % 12;
      var shared = a.pitchClasses.filter(function (pc) { return b.pitchClasses.indexOf(pc) !== -1; });
      var sharedNames = [];
      shared.forEach(function (pc) {
        var name = pitchClassName(pc);
        if (sharedNames.indexOf(name) === -1) sharedNames.push(name);
      });
      pairs.push({ a: a, b: b, intervalName: INTERVAL_NAMES[semi], sharedNames: sharedNames });
    }
  }
  pairs.sort(function (p, q) { return q.sharedNames.length - p.sharedNames.length; });
  return pairs;
}

function toneClusterNames(snapNodes) {
  var set = [];
  snapNodes.forEach(function (n) {
    n.pitchClasses.forEach(function (pc) {
      var name = pitchClassName(pc);
      if (set.indexOf(name) === -1) set.push(name);
    });
  });
  return set;
}

function formatSnapTime(ts) {
  var d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function loadSavedCombos() {
  try {
    var raw = localStorage.getItem(SAVED_COMBOS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function persistSavedCombos(list) {
  try { localStorage.setItem(SAVED_COMBOS_KEY, JSON.stringify(list)); } catch (e) {}
}

function renderSavedList() {
  var list = loadSavedCombos();
  savedListEl.innerHTML = "";
  if (!list.length) {
    var empty = document.createElement("div");
    empty.className = "snap-empty";
    empty.textContent = "No combinations saved yet.";
    savedListEl.appendChild(empty);
    return;
  }
  list.slice().reverse().forEach(function (combo) {
    var row = document.createElement("div");
    row.className = "saved-item";
    var left = document.createElement("div");
    var name = document.createElement("div");
    name.className = "saved-name";
    name.textContent = combo.name;
    var meta = document.createElement("div");
    meta.className = "saved-meta";
    meta.textContent = new Date(combo.savedAt).toLocaleDateString() + " · " + combo.toneNames.join(", ");
    left.appendChild(name);
    left.appendChild(meta);
    var actions = document.createElement("div");
    actions.className = "saved-actions";
    var share = document.createElement("button");
    share.className = "saved-share";
    share.textContent = "↗";
    share.title = "Copy a link to this combination";
    share.addEventListener("click", function (e) {
      if (e.stopPropagation) e.stopPropagation();
      var url = shareUrlFor(combo);
      var original = share.textContent;
      function flash(text) {
        share.textContent = text;
        setTimeout(function () { share.textContent = original; }, 1300);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { flash("copied!"); track("share-link-copied"); }, function () { flash("failed"); });
      } else {
        flash("failed");
      }
    });
    var del = document.createElement("button");
    del.className = "saved-del";
    del.textContent = "×";
    del.addEventListener("click", function (e) {
      if (e.stopPropagation) e.stopPropagation();
      var updated = loadSavedCombos().filter(function (c) { return c.id !== combo.id; });
      persistSavedCombos(updated);
      renderSavedList();
    });
    actions.appendChild(share);
    actions.appendChild(del);
    row.title = "Tap to load this combination";
    row.addEventListener("click", function () { loadCombo(combo); });
    row.appendChild(left);
    row.appendChild(actions);
    savedListEl.appendChild(row);
  });
}

// ── Isolated interval preview — a relationship line, made audible ──
// Played with overtones (a filtered sawtooth, not a bare sine) and both
// notes centred, because beating happens where harmonics overlap in the
// same ear — two sines panned apart can't show it. Tuned by the current
// north: magnetic plays the piano's interval, true plays the pure ratio,
// so tapping the same line under each north is the whole lesson in 2s.
function previewInterval(aMidi, bMidi) {
  if (!audioCtx) return;
  resumeAudio();
  var t0 = audioCtx.currentTime + 0.02;
  var semi = bMidi - aMidi;
  var fa = midiToFreq(aMidi);
  var fb = midiToFreq(bMidi);
  if (trueNorth) {
    var m = ((semi % 12) + 12) % 12, oct = Math.floor(semi / 12);
    var r = INTERVAL_RATIOS[m];
    fb = fa * (r[0] / r[1]) * Math.pow(2, oct);
  }
  var lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2400;
  lp.Q.value = 0.5;
  lp.connect(masterGain);
  [fa, fb].forEach(function (freq, i) {
    var osc = audioCtx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    var g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.06, t0 + 0.08);
    g.gain.setValueAtTime(0.06, t0 + 1.9);
    g.gain.linearRampToValueAtTime(0.0001, t0 + 2.5);
    osc.connect(g);
    g.connect(lp);
    osc.start(t0 + i * 0.015);
    osc.stop(t0 + 2.6);
  });
}

// ── Continued laboration in the panel — nudge a still-live note without
// leaving the snapshot, hear it immediately, refresh relationships live ──
function nudgeSnapshotNote(id, delta) {
  var liveNode = snapshotLiveNodes.filter(function (n) { return n.id === id; })[0];
  if (!liveNode || liveNode.pruned || liveNode._flightId) return; // aircraft fly themselves
  // Move to the next/previous COLUMN in the active grid (diatonic or
  // chromatic), not an arbitrary semitone — a raw +/-1 semitone can land
  // on a pitch class that has no column at all in diatonic mode (C has
  // no C# slot), leaving the note sounding one thing while sitting
  // somewhere that implies another. updateNodePosition is the single
  // place position-to-pitch happens elsewhere in the app; reusing it here
  // guarantees the dot always sits where its own pitch actually is.
  var notes = activeNotes();
  var xFrac = clamp(liveNode.x / W, 0, 1);
  var idx = Math.min(notes.length - 1, Math.floor(xFrac * notes.length));
  var newIdx = clamp(idx + delta, 0, notes.length - 1);
  var newX = (newIdx + 0.5) / notes.length * W;
  updateNodePosition(liveNode, newX, liveNode.y);
  previewNode(liveNode);
  var active = nodes.filter(function (n) { return !n.pruned; });
  snapshotLiveNodes = active;
  var refreshed = buildSnapshot(active);
  currentSnapshot = refreshed;
  renderSnapshot(refreshed);
}

// ── Vocabulary — a quiet, ungamified record of intervals and chord colors
// encountered. No score, no competition, just what has been met before ──
var VOCAB_KEY = "aeolaVocabulary";
function loadVocabulary() {
  try {
    var raw = localStorage.getItem(VOCAB_KEY);
    return raw ? JSON.parse(raw) : { intervals: {}, colors: {} };
  } catch (e) { return { intervals: {}, colors: {} }; }
}
function persistVocabulary(v) {
  try { localStorage.setItem(VOCAB_KEY, JSON.stringify(v)); } catch (e) {}
}
function recordVocabulary(snap) {
  if (!snap.nodes.length) return { newColorLabels: [], newIntervalNames: [] };
  var vocab = loadVocabulary();
  var newIntervalNames = [];
  if (snap.nodes.length > 1) {
    relationshipsFor(snap.nodes).forEach(function (p) {
      if (!vocab.intervals[p.intervalName]) newIntervalNames.push(p.intervalName);
      vocab.intervals[p.intervalName] = (vocab.intervals[p.intervalName] || 0) + 1;
    });
  }
  var newColorLabels = [];
  snap.nodes.forEach(function (nd) {
    var label = nd.quality + colorLabelFor(nd.color);
    if (!vocab.colors[label]) newColorLabels.push(label);
    vocab.colors[label] = (vocab.colors[label] || 0) + 1;
  });
  persistVocabulary(vocab);
  return { newColorLabels: newColorLabels, newIntervalNames: newIntervalNames };
}
function renderVocabularySection(vocab) {
  var names = Object.keys(vocab.intervals).concat(Object.keys(vocab.colors));
  if (!names.length) return null;
  var section = document.createElement("div");
  section.className = "snap-section";
  var label = document.createElement("div");
  label.className = "snap-label";
  label.textContent = "in your vocabulary";
  section.appendChild(label);
  names.forEach(function (name) {
    var chip = document.createElement("span");
    chip.className = "snap-chip";
    chip.textContent = name;
    section.appendChild(chip);
  });
  return section;
}

// ── Colour wheel — hue = pitch class, radius = octave register.
// Pure visualisation, NOT draggable: changes happen only through the ▲▼
// buttons under "notes sounding", and the wheel redraws what they did.
// (Dragging dots or the whole wheel was removed — simpler, and one less
// thing that can disagree with the room.)
var WHEEL_INNER_R = 34, WHEEL_MID_R = 62, WHEEL_OUTER_R = 90, WHEEL_MAX_R = 96;

function wheelOctaveShiftOf(node, notes) {
  var pc = ((node.rootMidi % 12) + 12) % 12;
  var match = notes.filter(function (nt) { return nt.midi % 12 === pc; })[0];
  var baseMidi = match ? match.midi : (60 + pc);
  return node.rootMidi - baseMidi;
}
function wheelRadiusForOctave(shift) {
  return shift > 0 ? WHEEL_INNER_R : (shift < 0 ? WHEEL_OUTER_R : WHEEL_MID_R);
}
function wheelColumnOf(node, notes) {
  var xFrac = clamp(node.x / W, 0, 1);
  return Math.min(notes.length - 1, Math.floor(xFrac * notes.length));
}

function drawWheel() {
  var canvas = document.getElementById("wheelCanvas");
  if (!canvas) return;
  var wctx = canvas.getContext("2d");
  // Same pattern as the main canvas: draw in a fixed 200×200 logical space,
  // backed by dpr times as many physical pixels, so it's as sharp as the
  // rest of the interface on a Retina screen.
  if (canvas._dprSetup !== dpr) {
    canvas.width = 200 * dpr;
    canvas.height = 200 * dpr;
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas._dprSetup = dpr;
  }
  var cx = 100, cy = 100;
  wctx.clearRect(0, 0, 200, 200);
  var notes = activeNotes();
  var n = notes.length;
  for (var i = 0; i < n; i++) {
    var hue = ((notes[i].midi % 12) + 12) % 12 * 30;
    var ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    wctx.beginPath();
    wctx.moveTo(cx + Math.cos(ang) * (WHEEL_MAX_R - 8), cy + Math.sin(ang) * (WHEEL_MAX_R - 8));
    wctx.lineTo(cx + Math.cos(ang) * WHEEL_MAX_R, cy + Math.sin(ang) * WHEEL_MAX_R);
    wctx.strokeStyle = "hsl(" + hue + ",65%,58%)";
    wctx.lineWidth = 3;
    wctx.stroke();
  }
  var active = nodes.filter(function (nd) { return !nd.pruned && nd.kind !== "field"; });
  active.forEach(function (nd) {
    var pc = ((nd.rootMidi % 12) + 12) % 12;
    var hue = pc * 30;
    var shift = wheelOctaveShiftOf(nd, notes);
    var r = wheelRadiusForOctave(shift);
    // The angle follows the same even column split as the tick marks (the
    // room's X axis is "even columns", not a true pitch circle — C major's
    // 2-2-1-2-2 step pattern isn't spread evenly over 360°). The colour,
    // though, is always the true pitch.
    var col = wheelColumnOf(nd, notes);
    var ang = (col / notes.length) * Math.PI * 2 - Math.PI / 2;
    var x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
    wctx.beginPath();
    wctx.arc(x, y, 7, 0, Math.PI * 2);
    wctx.fillStyle = "hsl(" + hue + ",75%,62%)";
    wctx.fill();
    // Locked notes get a clearly thicker, brighter outline — the only way to
    // see what's locked without opening each note's panel.
    wctx.lineWidth = nd.frozen ? 3 : 1.5;
    wctx.strokeStyle = nd.frozen ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.55)";
    wctx.stroke();
  });
}

function renderSnapshot(snap) {
  snapTimeEl.textContent = formatSnapTime(snap.time);
  snapshotBodyEl.innerHTML = "";
  drawWheel();

  if (snap.hasField) {
    var fieldLine = document.createElement("div");
    fieldLine.className = "snap-line";
    fieldLine.textContent = "field recording looping";
    snapshotBodyEl.appendChild(fieldLine);
  }

  if (!snap.nodes.length) {
    var empty = document.createElement("div");
    empty.className = "snap-empty";
    empty.textContent = "Nothing sounding right now. Place or hold a note, then take a snapshot.";
    snapshotBodyEl.appendChild(empty);
    return;
  }

  var vocabDelta = recordVocabulary(snap);

  var chordsSection = document.createElement("div");
  chordsSection.className = "snap-section";
  var chordsLabel = document.createElement("div");
  chordsLabel.className = "snap-label";
  chordsLabel.textContent = snap.nodes.length + " note" + (snap.nodes.length > 1 ? "s" : "") + " sounding";
  // A quiet color cue for how settled vs. restless this combination is —
  // never a number, never a score, just a felt tint on the header itself.
  var tension = snapshotTension(snap.nodes);
  var tensionRgb = mixRgb([90, 200, 190], [235, 120, 140], tension);
  chordsLabel.style.borderLeft = "2px solid rgba(" + tensionRgb.join(",") + ",0.75)";
  chordsLabel.style.paddingLeft = "8px";
  chordsSection.appendChild(chordsLabel);
  snap.nodes.forEach(function (n, i) {
    var row = document.createElement("span");
    row.className = "snap-chip-row";
    var down = document.createElement("button");
    down.className = "nudge-btn";
    down.textContent = "▼";
    down.title = "Move to the previous note in the grid";
    down.addEventListener("click", function () { nudgeSnapshotNote(n.id, -1); });
    var chip = document.createElement("span");
    chip.className = "snap-chip";
    if (vocabDelta.newColorLabels.indexOf(n.quality + colorLabelFor(n.color)) !== -1) {
      chip.classList.add("chip-new");
      chip.title = "First time in your vocabulary";
    }
    chip.textContent = chordLabel(n);
    var up = document.createElement("button");
    up.className = "nudge-btn";
    up.textContent = "▲";
    up.title = "Move to the next note in the grid";
    up.addEventListener("click", function () { nudgeSnapshotNote(n.id, 1); });
    if (!n.flight) row.appendChild(down); // aircraft can't be nudged
    row.appendChild(chip);
    if (!n.flight) row.appendChild(up);
    chordsSection.appendChild(row);
  });
  snapshotBodyEl.appendChild(chordsSection);

  if (snap.nodes.length > 1) {
    var relSection = document.createElement("div");
    relSection.className = "snap-section";
    var relLabel = document.createElement("div");
    relLabel.className = "snap-label";
    relLabel.textContent = "bearings";
    relSection.appendChild(relLabel);
    var pairs = relationshipsFor(snap.nodes).slice(0, 6);
    pairs.forEach(function (p) {
      var line = document.createElement("div");
      line.className = "snap-line";
      if (vocabDelta.newIntervalNames.indexOf(p.intervalName) !== -1) line.classList.add("rel-new");
      line.style.cursor = "pointer";
      line.title = "Tap to hear this interval alone, tap again for what it is";
      var semiForRatio = ((p.b.rootMidi - p.a.rootMidi) % 12 + 12) % 12;
      var ratio = INTERVAL_RATIOS[semiForRatio];
      var text = p.a.rootName + " to " + p.b.rootName + " — " + p.intervalName + " apart";
      if (semiForRatio !== 0) text += " (≈" + ratio[0] + ":" + ratio[1] + ")";
      if (p.sharedNames.length) text += ", sharing " + p.sharedNames.join(", ");
      var reading = syncReading(p.a.id, p.b.id);
      if (reading) text += " · " + reading;
      line.textContent = text;
      var semi = ((p.b.rootMidi - p.a.rootMidi) % 12 + 12) % 12;
      var relKey = p.intervalName + "|" + p.a.rootName + "|" + p.b.rootName;
      var detail = null;
      function showDetail(animate) {
        detail = document.createElement("div");
        detail.className = "snap-line rel-detail" + (animate ? " rel-detail-enter" : "");
        detail.textContent = INTERVAL_INSIGHTS[semi] + " " + intervalPhysicsLine(semi);
        line.insertAdjacentElement("afterend", detail);
      }
      line.addEventListener("click", function () {
        previewInterval(p.a.rootMidi, p.b.rootMidi);
        if (detail) { detail.remove(); detail = null; openRelDetails[relKey] = false; return; }
        showDetail(true);
        openRelDetails[relKey] = true;
      });
      // Must be added to the panel BEFORE showDetail() can restore it —
      // insertAdjacentElement("afterend", ...) needs the line to have a
      // parent already. In the wrong order this throws on every periodic
      // rebuild (500 ms), which aborts that render and means an expanded
      // detail could never show again after the first click.
      relSection.appendChild(line);
      // animate:false — this quietly restores an already-open detail during
      // the periodic rebuild; it isn't a new click, so the expand animation
      // shouldn't replay.
      if (openRelDetails[relKey]) showDetail(false);
    });
    snapshotBodyEl.appendChild(relSection);

    var toneSection = document.createElement("div");
    toneSection.className = "snap-section";
    var toneLabel = document.createElement("div");
    toneLabel.className = "snap-label";
    toneLabel.textContent = "tones in the air";
    toneSection.appendChild(toneLabel);
    var toneLine = document.createElement("div");
    toneLine.className = "snap-line";
    toneLine.textContent = toneClusterNames(snap.nodes).join(", ");
    toneSection.appendChild(toneLine);
    snapshotBodyEl.appendChild(toneSection);
  }

  var saveSection = document.createElement("div");
  saveSection.className = "snap-section";
  var saveLabel = document.createElement("div");
  saveLabel.className = "snap-label";
  saveLabel.textContent = "save this combination";
  var saveRow = document.createElement("div");
  saveRow.className = "save-row";
  var input = document.createElement("input");
  input.type = "text";
  input.placeholder = snap.nodes.map(function (n) { return n.rootName; }).join(" + ");
  input.maxLength = 40;
  var saveBtn = document.createElement("button");
  saveBtn.className = "save-btn";
  saveBtn.textContent = "save";
  saveBtn.addEventListener("click", function () {
    var list = loadSavedCombos();
    var name = input.value.trim() || snap.nodes.map(function (n) { return chordLabel(n); }).join(" + ");
    list.push({
      id: "c" + Date.now() + Math.floor(Math.random() * 1000),
      name: name,
      savedAt: snap.time,
      nodes: snap.nodes,
      toneNames: toneClusterNames(snap.nodes)
    });
    if (list.length > 30) list = list.slice(list.length - 30);
    persistSavedCombos(list);
    track("combination-saved", { notes: snap.nodes.length });
    renderSavedList();
    input.value = "";
    saveBtn.textContent = "saved";
    setTimeout(function () { saveBtn.textContent = "save"; }, 1200);
  });
  saveRow.appendChild(input);
  saveRow.appendChild(saveBtn);
  saveSection.appendChild(saveLabel);
  saveSection.appendChild(saveRow);
  snapshotBodyEl.appendChild(saveSection);

  var vocabSection = renderVocabularySection(loadVocabulary());
  if (vocabSection) snapshotBodyEl.appendChild(vocabSection);
}

function openSnapshotPanel() {
  closeNodePanel();
  closeWeatherPanel();
  snapshotPanel.classList.add("visible");
}

function closeSnapshotPanel() {
  snapshotPanel.classList.remove("visible");
  if (snapshotRefreshTimer) { clearInterval(snapshotRefreshTimer); snapshotRefreshTimer = null; }
}

function triggerShutter(onClosed) {
  shutterEl.classList.add("closing");
  setTimeout(function () {
    if (onClosed) onClosed();
    setTimeout(function () {
      shutterEl.classList.remove("closing");
    }, 80);
  }, 320);
}

var snapshotRefreshTimer = null;
// Which relationship details are expanded right now, keyed by a stable
// pair ID — must live OUTSIDE renderSnapshot, or the rebuild every 500 ms
// would reset it.
var openRelDetails = {};
function refreshSnapshotPanel() {
  var active = nodes.filter(function (n) { return !n.pruned; });
  snapshotLiveNodes = active;
  var snap = buildSnapshot(active);
  currentSnapshot = snap;
  renderSnapshot(snap);
}

snapshotBtn.addEventListener("click", function () {
  track("snapshot-opened");
  markInteracted();
  triggerShutter(function () {
    openRelDetails = {}; // new snapshot session — start with everything collapsed
    refreshSnapshotPanel();
    openSnapshotPanel();
    // The panel is "live": otherwise it only showed the moment the button
    // was pressed — opened before any note existed it never updated, and a
    // note that faded out stayed in the list. A moderate refresh rate is
    // enough (notes change every 4–7 s) without the text flickering.
    if (snapshotRefreshTimer) clearInterval(snapshotRefreshTimer);
    snapshotRefreshTimer = setInterval(refreshSnapshotPanel, 500);
  });
});
snapshotPanelClose.addEventListener("click", closeSnapshotPanel);
renderSavedList();

// ── Share link — there's no backend, so the whole room has to fit in the
// link itself. Raw JSON of an 8-note room is close to 2 KB, too long to
// trust in a URL, so each note is packed into 10 fixed bytes (position as
// a fraction of the room, not pixels — so a link looks right on any
// screen) plus a small name header, then base64-encoded.
var SHARE_COLORS = ["triad", "add9", "sus4", "open5th"];
// Order is part of the link format — only ever append. "cold" and "rich"
// (the Arlanda and Cologne voices) were missing, so a shared flight room
// came back in the default timbre. The timbre field is 3 bits wide now;
// old links only ever used the lower two, so they decode unchanged.
var SHARE_TIMBRES = ["pure", "warm", "resonant", "nasal", "cold", "rich"];

function encodeSharedCombo(combo) {
  var name = (combo.name || "shared airspace").slice(0, 60);
  var nameBytes = new TextEncoder().encode(name);
  var nodeBytes = [];
  combo.nodes.forEach(function (n) {
    var xFrac = clamp(Math.round((n.x / W) * 255), 0, 255);
    var yFrac = clamp(Math.round((n.y / H) * 255), 0, 255);
    var rootMidi = clamp(Math.round(n.rootMidi), 0, 255);
    var colorIdx = Math.max(0, SHARE_COLORS.indexOf(n.color));
    var timbreIdx = Math.max(0, SHARE_TIMBRES.indexOf(n.timbre));
    var packed = (n.quality === "major" ? 1 : 0) | (colorIdx << 1) | (timbreIdx << 3);
    nodeBytes.push(
      xFrac, yFrac, rootMidi, packed,
      clamp(Math.round((n.vibrato || 0) * 255), 0, 255),
      clamp(Math.round((n.reverbSend || 0) * 255), 0, 255),
      clamp(Math.round((n.delaySend || 0) * 255), 0, 255),
      clamp(Math.round(((n.stretch || 1) / 4) * 255), 0, 255),
      clamp(Math.round(((n.sizeScale || 1) / 2) * 255), 0, 255),
      clamp(Math.round((n.lastGain != null ? n.lastGain : 0.85) * 255), 0, 255)
    );
  });
  var header = [1, combo.nodes.length, nameBytes.length];
  var all = new Uint8Array(header.length + nameBytes.length + nodeBytes.length);
  all.set(header, 0);
  all.set(nameBytes, header.length);
  all.set(nodeBytes, header.length + nameBytes.length);
  var bin = "";
  all.forEach(function (b) { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSharedCombo(str) {
  var bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var count = bytes[1];
  var nameLen = bytes[2];
  var name = new TextDecoder().decode(bytes.subarray(3, 3 + nameLen));
  var offset = 3 + nameLen;
  var nodes = [];
  for (var i = 0; i < count; i++) {
    var o = offset + i * 10;
    var xFrac = bytes[o], yFrac = bytes[o + 1], rootMidi = bytes[o + 2], packed = bytes[o + 3];
    var vibrato = bytes[o + 4], reverbSend = bytes[o + 5], delaySend = bytes[o + 6];
    var stretch = bytes[o + 7], sizeScale = bytes[o + 8], lastGain = bytes[o + 9];
    nodes.push({
      x: (xFrac / 255) * W, y: (yFrac / 255) * H,
      rootMidi: rootMidi, rootName: pitchClassName(((rootMidi % 12) + 12) % 12),
      quality: (packed & 1) ? "major" : "minor",
      color: SHARE_COLORS[(packed >> 1) & 3],
      timbre: SHARE_TIMBRES[(packed >> 3) & 7] || "pure",
      vibrato: vibrato / 255, reverbSend: reverbSend / 255, delaySend: delaySend / 255,
      stretch: (stretch / 255) * 4, sizeScale: (sizeScale / 255) * 2 || 1,
      lastGain: lastGain / 255
    });
  }
  return { name: name, nodes: nodes };
}

function shareUrlFor(combo) {
  return location.href.split("#")[0] + "#room=" + encodeSharedCombo(combo);
}

function loadSharedRoomFromHash() {
  var m = location.hash.match(/^#room=(.+)$/);
  if (!m) return;
  history.replaceState(null, "", location.href.split("#")[0]); // a reload shouldn't load the shared room a second time
  try {
    var combo = decodeSharedCombo(m[1]);
    loadCombo(combo);
    showSharedRoomToast(combo.name);
    track("shared-room-opened", { notes: combo.nodes.length });
  } catch (e) {
    console.warn("Could not read shared link:", e);
  }
}

function showSharedRoomToast(name) {
  showToast("Loaded \u201C" + name + "\u201D — tap anywhere to hear it.", 3400);
}

function loadCombo(combo) {
  if (nodes.length && !window.confirm("Replace the current airspace with \"" + combo.name + "\"?")) return;
  clearAllNodes();
  closeSnapshotPanel();
  initAudio();
  resumeAudio();
  markInteracted();
  var items = combo.nodes.slice().sort(function (a, b) { return a.rootMidi - b.rootMidi; });
  var n = Math.max(1, items.length);
  items.forEach(function (item, i) {
    // Older saved combos (before the full-state fix) only have pitch
    // fields — fall back to an even spread and defaults rather than
    // breaking on load.
    var hasFullState = typeof item.x === "number" && typeof item.y === "number";
    var x = hasFullState ? item.x : ((i + 0.5) / n) * W;
    var y = hasFullState ? item.y : H * 0.5;
    var node = spawnNode(x, y, {
      // Loading a saved combination is a deliberate act of bringing a
      // landscape back — it should stay, not quietly decay away a few
      // seconds later. Always locked on load, regardless of whether it
      // was locked when saved.
      frozen: true,
      timbre: item.timbre, color: item.color,
      vibrato: hasFullState ? item.vibrato : DEFAULT_VIBRATO,
      reverbSend: hasFullState ? item.reverbSend : DEFAULT_REVERB,
      delaySend: hasFullState ? item.delaySend : DEFAULT_DELAY,
      stretch: hasFullState ? item.stretch : DEFAULT_STRETCH
    });
    if (!node) return; // the room is full — the rest of the combination is skipped
    node.rootMidi = item.rootMidi;
    node.rootName = item.rootName;
    node.quality = item.quality;
    node.sizeScale = hasFullState ? (item.sizeScale || 1) : 1;
    hit(node, hasFullState ? (item.lastGain || 0.85) : 0.85);
  });
}
