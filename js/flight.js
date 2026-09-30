"use strict";

// ── Flight mode — the room tuned to live air traffic over a real airport.
//
// The screen is read as a PROFILE view, the side-elevation an approach or
// departure chart uses: horizontal is real east-west geography, vertical is
// altitude. That falls out of Aeola's own mapping for free — X already picks
// the note and Y already picks the octave — so an aircraft climbing out
// literally rises up the screen AND up through the registers, and one parked
// at a gate sits at the bottom as a low pedal tone.
//
// Between polls the aircraft keep flying on their last known heading, speed
// and climb rate. That's dead reckoning — estimating a position from a known
// fix plus time elapsed — which is both the honest way to fill the gap and
// the reason this only needs to call the network every two minutes.
// api/flights.js on Vercel. On a plain PHP host, flights.php (kept in the
// repo) does the same job — point this at "flights.php" there.
var FLIGHT_ENDPOINT = "api/flights";
var FLIGHT_AIRPORTS = [
  { key: "essa", label: "arlanda" },
  // Music for Airports was written for Cologne Bonn. The nod is the point.
  { key: "eddk", label: "cologne" }
];
// Each airport's own sonic identity — designed in tools/synth-lab.html
// against a fixed reference (Aeola's default voice); see TIMBRE_CONFIG's
// "cold"/"rich" entries for the timbre reasoning. weather mirrors the
// weather-panel sliders (0-100) and applies the moment flight mode starts
// — setFlightMode() saves whatever was set before and restores it when
// flight mode turns off, so this never clobbers a hand-made setup.
var FLIGHT_AMBIENCE = {
  essa: {
    timbre: "cold", vibrato: 0.05, reverbSend: 0.8, delaySend: 0.35,
    stretchBase: 1.3,  // Arlanda additionally stretches everything — a slow, uniform, held-breath quality
    weather: { reverb: 75, dist: 5, phase: 15 }
  },
  eddk: {
    timbre: "rich", vibrato: 0.15, reverbSend: 0.35, delaySend: 0.45,
    stretchBase: 1.0,  // Cologne's own cargo/passenger stretch contrast (2.2 vs 1.0) already carries the "unequal loop lengths" idea — no extra multiplier needed
    weather: { reverb: 40, dist: 35, phase: 55 }
  }
};
var FLIGHT_POLL_MS = 120000;
// Not cruise altitude: within 40 km of an airport almost everything is
// climbing out or on approach, so a 38000 ft ceiling left the top octave
// permanently empty and squashed real traffic into two registers. 20000
// spans the three bands with the altitudes that actually show up here;
// anything higher is overflying traffic and simply pins to the top.
var FLIGHT_CEILING_FT = 20000;
var flightIndex = -1;          // -1 = off, otherwise an index into FLIGHT_AIRPORTS
var flightMeta = null;         // airport block from the proxy
var flightPollTimer = null;
var flightLastFrameAt = null;

function flightIsOn() { return flightIndex >= 0; }

// The airport itself is now the dominant voice (FLIGHT_AMBIENCE's "cold"
// or "rich"), not aircraft type or cargo status — a real, audible
// difference in EVERY note at that airport, rather than a difference
// between two categories of note. Cargo vs. passenger still comes
// through clearly, just through size and stretch (below) instead of a
// timbre swap. Rotorcraft are the one exception: a police or medevac
// helicopter isn't airline traffic and shouldn't share either airport's
// signature voice.
function flightTimbre(type, airportKey) {
  var s = (type || "").toUpperCase();
  if (/^(EC|R44|R66|AS3|SA3)/.test(s)) return "nasal";  // rotorcraft — distinct oddity, not the airport's own voice
  var ambience = FLIGHT_AMBIENCE[airportKey];
  return ambience ? ambience.timbre : "pure";
}
function flightSize(type, cargo) {
  var s = (type || "").toUpperCase();
  var base;
  if (/^(A33|A34|A35|A38|B74|B76|B77|B78)/.test(s)) base = 1.15;       // heavy widebody
  else if (/^(A19|A2|A31|A32|B3|B7|E19|CRJ|AT7)/.test(s)) base = 0.85; // narrowbody & regional
  else base = 0.7;                                                    // light
  // A cargo aircraft reads as noticeably larger than a passenger one of
  // the same underlying type — the size difference the ear should
  // actually notice, not the airframe class.
  return cargo ? base * 1.55 : base * 0.85;
}
function flightStretch(cargo, airportKey) {
  // Longer, slower-breathing drones for freight — matches the
  // lumbering, steady-cruise character of cargo ops versus the
  // ordinary up-and-down rhythm of passenger traffic. The airport's own
  // stretchBase then scales that further (Arlanda stretches everything;
  // Cologne leaves the cargo/passenger contrast as the only variation).
  var base = cargo ? 2.2 : 1.0;
  var ambience = FLIGHT_AMBIENCE[airportKey];
  var scaled = base * (ambience ? ambience.stretchBase : 1);
  return clamp(scaled, STRETCH_MIN, STRETCH_MAX);
}
function flightQuality(rate) {
  if (rate > 250) return "major";   // climbing out
  if (rate < -250) return "minor";  // on the way down
  return "major";                   // level
}

// Longitude + altitude -> a point on the canvas.
function flightScreenPos(lon, altFt) {
  var kmPerDegLon = 111.32 * Math.cos(flightMeta.lat * Math.PI / 180);
  var halfSpanDeg = flightMeta.dist / kmPerDegLon;
  var xFrac = clamp(0.5 + (lon - flightMeta.lon) / (2 * halfSpanDeg), 0.03, 0.97);
  // Square root so the low end — where all the airport traffic actually is —
  // gets most of the screen instead of being squashed into the bottom strip.
  var altFrac = Math.sqrt(clamp(altFt / FLIGHT_CEILING_FT, 0, 1));
  var yFrac = 0.92 - altFrac * 0.84;
  return { x: xFrac * W, y: yFrac * H };
}

function applyFlightState(node, ac) {
  var airportKey = flightMeta ? flightMeta.key : null;
  node._flightId = ac.id;
  node._flightCall = ac.call;
  node._flightLon = ac.lon;
  node._flightAlt = ac.alt;
  node._flightTrk = ac.trk;
  node._flightGs = ac.gs;
  node._flightRate = ac.rate;
  node._flightGnd = !!ac.gnd;
  node._flightType = ac.type;
  node._flightCargo = !!ac.cargo;
  node.timbre = flightTimbre(ac.type, airportKey);
  node.quality = flightQuality(ac.rate);
  node.sizeScale = flightSize(ac.type, ac.cargo);
  node.stretch = flightStretch(ac.cargo, airportKey);
}

function removeFlightNode(node) {
  node.pruned = true;
  if (node.timerId) clearTimeout(node.timerId);
  var i = nodes.indexOf(node);
  if (i >= 0) nodes.splice(i, 1);
  if (editingNode === node) closeNodePanel();
}

// ── Check-in — aircraft join the room one at a time, nearest to the
// runway first, the way flights call the tower one after another. Starting
// them all at once was a wall of sound, and they then pulsed in step.
// Each aircraft also arrives soft (FLIGHT_FADE_START) and swells to full
// over a few strikes, and repeats on its own fixed loop length, so the
// room settles into a slowly shifting polyrhythm instead of one pulse.
var FLIGHT_CHECKIN_MIN_MS = 2200;
var FLIGHT_CHECKIN_JITTER_MS = 1800;
var FLIGHT_FADE_START = 0.25;
var FLIGHT_FULL_GAIN = 0.8;
var FLIGHT_APPEAR_MS = 2500; // ring, glow, callsign and connectors grow in over this long
// One loop length per aircraft (in ms, before cargo/airport stretch). Tape
// loops of unequal length, as in Music for Airports: the tenths are all
// prime (53, 59, 67...), so no two loops share a common beat and the room
// never falls back into step. Eight lengths for up to MAX_NODES aircraft.
var FLIGHT_LOOP_MS = [5300, 5900, 6700, 7300, 7900, 8300, 8900, 9700];
var flightQueue = [];          // aircraft waiting to check in, nearest first
var flightCheckinTimer = null;

function findFlightNode(id) {
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i]._flightId === id && !nodes[i].pruned) return nodes[i];
  }
  return null;
}

// Same aircraft, same loop: picked from its id, skipping lengths already
// taken by aircraft in the room so no two share a period.
function flightLoopFor(ac) {
  var taken = {};
  nodes.forEach(function (n) { if (n._flightId && !n.pruned && n.loopMs) taken[n.loopMs] = true; });
  var h = 0;
  for (var i = 0; i < ac.id.length; i++) h = (h * 31 + ac.id.charCodeAt(i)) >>> 0;
  for (var k = 0; k < FLIGHT_LOOP_MS.length; k++) {
    var ms = FLIGHT_LOOP_MS[(h + k) % FLIGHT_LOOP_MS.length];
    if (!taken[ms]) return ms;
  }
  return FLIGHT_LOOP_MS[h % FLIGHT_LOOP_MS.length];
}

function clearFlightQueue() {
  flightQueue = [];
  if (flightCheckinTimer) { clearTimeout(flightCheckinTimer); flightCheckinTimer = null; }
}

function scheduleCheckIn(delayMs) {
  if (flightCheckinTimer || !flightQueue.length) return;
  flightCheckinTimer = setTimeout(checkInNextAircraft, delayMs);
}

function checkInNextAircraft() {
  flightCheckinTimer = null;
  if (!flightIsOn() || !flightMeta) return;
  while (flightQueue.length && findFlightNode(flightQueue[0].id)) flightQueue.shift();
  if (flightQueue.length && nodes.length < MAX_NODES) spawnFlightNode(flightQueue.shift());
  scheduleCheckIn(FLIGHT_CHECKIN_MIN_MS + Math.random() * FLIGHT_CHECKIN_JITTER_MS);
}

function spawnFlightNode(ac) {
  // The fix is from the last poll; fly it forward by the time it spent
  // waiting in the queue, so it appears where it actually is now.
  var waitedSec = (performance.now() - (ac._queuedAt || performance.now())) / 1000;
  if (!ac.gnd && waitedSec > 0) {
    var kmPerDegLon = 111.32 * Math.cos(flightMeta.lat * Math.PI / 180);
    ac.lon += (Math.sin(ac.trk * Math.PI / 180) * (ac.gs * 1.852 / 3600) * waitedSec) / kmPerDegLon;
    ac.alt = Math.max(0, ac.alt + (ac.rate / 60) * waitedSec);
  }
  var pos = flightScreenPos(ac.lon, ac.alt);
  var ambience = FLIGHT_AMBIENCE[flightMeta.key] || {};
  var node = spawnNode(pos.x, pos.y, {
    frozen: true,   // aircraft sustain as drones; they're removed by the feed, not by decay
    timbre: flightTimbre(ac.type, flightMeta.key),
    color: "triad",
    vibrato: ambience.vibrato != null ? ambience.vibrato : DEFAULT_VIBRATO,
    reverbSend: ambience.reverbSend != null ? ambience.reverbSend : DEFAULT_REVERB,
    delaySend: ambience.delaySend != null ? ambience.delaySend : DEFAULT_DELAY,
    stretch: flightStretch(ac.cargo, flightMeta.key)
  });
  if (!node) return;
  applyFlightState(node, ac);  // also sets timbre/sizeScale/stretch — the template above just avoids a one-frame flash of defaults
  node.loopMs = flightLoopFor(ac);
  node.fadeTarget = FLIGHT_FULL_GAIN;
  node.bornAt = performance.now();
  node.appearMs = FLIGHT_APPEAR_MS;
  hit(node, FLIGHT_FADE_START);
}

function applyFlightData(data) {
  flightMeta = data.airport;
  var list = (data.aircraft || []).slice(0, MAX_NODES);
  var wanted = {};
  list.forEach(function (ac) { wanted[ac.id] = true; });

  // Anything that has left the box stops sounding, or never checks in.
  nodes.slice().forEach(function (n) {
    if (n._flightId && !wanted[n._flightId]) removeFlightNode(n);
  });
  flightQueue = flightQueue.filter(function (q) { return wanted[q.id]; });

  var now = performance.now();
  list.forEach(function (ac) {
    var existing = findFlightNode(ac.id);
    if (existing) {
      // Correct the dead-reckoned guess against the real fix, gliding
      // rather than snapping.
      var pos = flightScreenPos(ac.lon, ac.alt);
      applyFlightState(existing, ac);
      updateNodePosition(existing, pos.x, pos.y, DRIFT_PITCH_GLIDE);
      return;
    }
    ac._queuedAt = now;
    var queued = -1;
    for (var i = 0; i < flightQueue.length; i++) if (flightQueue[i].id === ac.id) queued = i;
    if (queued >= 0) flightQueue[queued] = ac; else flightQueue.push(ac);
  });
  flightQueue.sort(function (a, b) { return a.dist - b.dist; });

  // The first aircraft checks in straight away; the rest follow in turn.
  var anyInRoom = nodes.some(function (n) { return n._flightId && !n.pruned; });
  scheduleCheckIn(anyInRoom ? FLIGHT_CHECKIN_MIN_MS : 0);
}

function updateFlightMotion(now) {
  if (!flightIsOn() || !flightMeta) return;
  if (flightLastFrameAt == null) { flightLastFrameAt = now; return; }
  var dt = (now - flightLastFrameAt) / 1000;
  flightLastFrameAt = now;
  if (dt <= 0 || dt > 0.5) return;

  var kmPerDegLon = 111.32 * Math.cos(flightMeta.lat * Math.PI / 180);
  nodes.forEach(function (n) {
    if (!n._flightId || n.pruned) return;
    if (activeDrag && activeDrag.node === n) return;
    if (n._flightGnd) return;  // parked or taxiing — a pedal tone that stays put

    var kmPerSec = (n._flightGs * 1.852) / 3600;
    n._flightLon += (Math.sin(n._flightTrk * Math.PI / 180) * kmPerSec * dt) / kmPerDegLon;
    n._flightAlt = Math.max(0, n._flightAlt + (n._flightRate / 60) * dt);

    var pos = flightScreenPos(n._flightLon, n._flightAlt);
    updateNodePosition(n, pos.x, pos.y, DRIFT_PITCH_GLIDE);
  });
}

function drawFlightLabels() {
  if (!flightIsOn()) return;
  c2d.save();
  c2d.font = "10.5px ui-monospace, 'SF Mono', Menlo, monospace";
  c2d.textAlign = "center";
  var nowMs = performance.now();
  nodes.forEach(function (n) {
    if (!n._flightId || n.pruned) return;
    var appear = nodeAppear(n, nowMs);
    var label = n._flightGnd
      ? n._flightCall + " · gnd"
      : n._flightCall + " · " + (Math.round(n._flightAlt / 100) * 100);
    c2d.fillStyle = "rgba(130, 225, 175, " + (0.85 * appear) + ")";
    c2d.fillText(label, n.x, n.y - 14 * (n.sizeScale || 1) - 8 + (1 - appear) * 6);
  });
  c2d.restore();
}

function clearFlightNodes() {
  nodes.slice().forEach(function (n) { if (n._flightId) removeFlightNode(n); });
}

function pollFlights() {
  if (!flightIsOn()) return;
  var airport = FLIGHT_AIRPORTS[flightIndex];
  fetch(FLIGHT_ENDPOINT + "?ap=" + encodeURIComponent(airport.key), { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      if (!flightIsOn()) return;  // switched off while the request was in the air
      if (!data.aircraft || !data.aircraft.length) {
        showToast("No traffic over " + (data.airport ? data.airport.name : airport.label) + " right now.", 3400);
        return;
      }
      applyFlightData(data);
    })
    .catch(function (err) {
      console.warn("Flight mode: could not fetch traffic data:", err);
      showToast(navigator.onLine === false
        ? "Flight mode needs a connection — everything else works offline."
        : "Couldn't reach the flight feed right now — try again in a minute.", 3800);
      setFlightMode(-1);
    });
}

// Whatever the weather panel was set to before flight mode's first
// activation, saved once and restored on the way back to "off" — flight
// mode's own airport presets should never permanently overwrite a
// creative-mode setup you'd already dialed in.
var flightSavedWeather = null;

function applyFlightWeatherPreset(preset) {
  weatherReverbSlider.value = preset.reverb;
  weatherDistSlider.value = preset.dist;
  weatherPhaseSlider.value = preset.phase;
  if (!weatherEnabled) {
    weatherEnabled = true;
    weatherToggle.classList.add("on");
  }
  updateWeatherAudio();
}

function setFlightMode(index) {
  var wasOn = flightIsOn();
  flightIndex = index;
  flightLastFrameAt = null;
  clearFlightQueue();  // switching airports or turning off: nobody left waiting to check in
  if (flightPollTimer) { clearInterval(flightPollTimer); flightPollTimer = null; }
  setSeg("flightSeg", flightIndex);

  if (!flightIsOn()) {
    clearFlightNodes();
    flightMeta = null;
    if (flightSavedWeather) {
      weatherReverbSlider.value = flightSavedWeather.reverb;
      weatherDistSlider.value = flightSavedWeather.dist;
      weatherPhaseSlider.value = flightSavedWeather.phase;
      weatherEnabled = flightSavedWeather.enabled;
      weatherToggle.classList.toggle("on", weatherEnabled);
      updateWeatherAudio();
      flightSavedWeather = null;
    }
    return;
  }
  if (!wasOn) {
    // First activation this session (not just switching airports) —
    // capture the prior state exactly once.
    flightSavedWeather = {
      reverb: weatherReverbSlider.value, dist: weatherDistSlider.value,
      phase: weatherPhaseSlider.value, enabled: weatherEnabled
    };
  }
  var airport = FLIGHT_AIRPORTS[flightIndex];
  track("flight-started", { airport: airport.label });
  clearAllNodes();       // live traffic takes the room over completely
  initAudio();
  resumeAudio();
  markInteracted();
  applyFlightWeatherPreset(FLIGHT_AMBIENCE[airport.key].weather);
  pollFlights();
  flightPollTimer = setInterval(pollFlights, FLIGHT_POLL_MS);
}

function cycleFlightMode() {
  // off -> arlanda -> cologne -> off, the same one-button idiom the
  // chord-quality control already uses.
  var next = flightIndex + 1;
  setFlightMode(next >= FLIGHT_AIRPORTS.length ? -1 : next);
}
