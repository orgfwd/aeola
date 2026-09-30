"use strict";

// Menu rows carry a title and a one-line explanation; state changes
// ("recording…", "stop and save") rewrite only the title.
function itemTitle(btn) { var t = btn.querySelector(".item-title"); return t ? t.textContent : btn.textContent; }
function setItemTitle(btn, text) {
  var t = btn.querySelector(".item-title");
  if (t) t.textContent = text; else btn.textContent = text;
}

// ── Field recording — "capture" records 3 seconds of the room and loops
// it as its own kind of node. Position does NOT mean pitch here: Y drives a
// filter (up = bright, down = dark), X drives delay time and feedback
// together (short time + high feedback gives that glitchy tape-loop feel —
// the quirks, without a third separate control). Always locked, and one
// recording at a time: a new capture replaces the old one.
var micStream = null;
var fieldNode = null;
var recorderWorkletLoaded = null;

var RECORDER_WORKLET_SRC = [
  "class RecorderProcessor extends AudioWorkletProcessor {",
  "  constructor(options) {",
  "    super();",
  "    var opts = (options && options.processorOptions) || {};",
  "    this.targetLength = Math.floor(sampleRate * (opts.seconds || 3));",
  "    this.buffer = new Float32Array(this.targetLength);",
  "    this.writeIndex = 0;",
  "    this.done = false;",
  "  }",
  "  process(inputs) {",
  "    if (this.done) return true;",
  "    var input = inputs[0][0];",
  "    if (input) {",
  "      for (var i = 0; i < input.length && this.writeIndex < this.targetLength; i++) {",
  "        this.buffer[this.writeIndex++] = input[i];",
  "      }",
  "    }",
  "    if (this.writeIndex >= this.targetLength) {",
  "      this.done = true;",
  "      this.port.postMessage({ done: true, buffer: this.buffer }, [this.buffer.buffer]);",
  "    }",
  "    return !this.done;",
  "  }",
  "}",
  "registerProcessor(\"recorder-processor\", RecorderProcessor);"
].join("\n");

function loadRecorderWorklet(ctx) {
  if (recorderWorkletLoaded) return recorderWorkletLoaded;
  var blob = new Blob([RECORDER_WORKLET_SRC], { type: "application/javascript" });
  var url = URL.createObjectURL(blob);
  recorderWorkletLoaded = ctx.audioWorklet.addModule(url).then(function () {
    URL.revokeObjectURL(url);
  });
  return recorderWorkletLoaded;
}

function ensureMicStream() {
  // Ask iOS for a session that allows input before asking for the mic
  // (see claimPlaybackSession in audio.js).
  micInUse = true;
  claimPlaybackSession();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return Promise.reject(new Error("getUserMedia unavailable"));
  }
  // Echo cancellation, noise suppression and auto-gain are switched off
  // explicitly — they're built for voice calls and would "clean away"
  // exactly the ambient sound this is meant to catch.
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  }).then(function (stream) { micStream = stream; return stream; });
}

// The mic is released after every take: the phone's recording indicator
// goes away, and iOS can return to the "playback" session that plays
// through the silent switch at full volume.
function releaseMic() {
  if (micStream) {
    micStream.getTracks().forEach(function (t) { t.stop(); });
    micStream = null;
  }
  micInUse = false;
  claimPlaybackSession();
}

// A short crossfade between the end and the start of the recording —
// otherwise the loop seam almost always clicks, since the start and end
// amplitudes of a raw 3-second recording rarely match.
function crossfadeLoopSeam(data, sr) {
  var fadeLen = Math.min(data.length >> 2, Math.floor(sr * 0.015));
  for (var i = 0; i < fadeLen; i++) {
    var frac = i / fadeLen;
    var tail = data[data.length - fadeLen + i];
    data[i] = data[i] * frac + tail * (1 - frac);
  }
  return data;
}

function fieldParamsFor(px, py) {
  var xFrac = clamp(px / W, 0, 1), yFrac = clamp(py / H, 0, 1);
  return {
    filterFreq: lerp(300, 12000, 1 - yFrac),
    delayTime: lerp(0.02, 0.6, xFrac),
    feedback: lerp(0.1, 0.75, xFrac)
  };
}

function removeFieldNode() {
  if (!fieldNode) return;
  fieldNode.pruned = true;
  if (fieldNode.stopField) fieldNode.stopField();
  var idx = nodes.indexOf(fieldNode);
  if (idx >= 0) nodes.splice(idx, 1);
  fieldNode = null;
}

function spawnFieldNode(px, py, buffer) {
  removeFieldNode(); // one recording at a time — a new capture replaces the old
  var src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  var filt = audioCtx.createBiquadFilter();
  filt.type = "lowpass";
  filt.Q.value = 0.7;
  var delay = audioCtx.createDelay(1.0);
  var fb = audioCtx.createGain();
  var wet = audioCtx.createGain();
  wet.gain.value = 0.5;
  var dry = audioCtx.createGain();
  dry.gain.value = 0.7;
  var out = audioCtx.createGain();
  out.gain.value = 0.5;
  // Safety limiter: fast parameter ramps while dragging can briefly build
  // up energy in the feedback loop before it settles — a soft limiter
  // catches it before it clips.
  var limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -18;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;

  var p = fieldParamsFor(px, py);
  filt.frequency.value = p.filterFreq;
  delay.delayTime.value = p.delayTime;
  fb.gain.value = p.feedback;

  src.connect(filt);
  filt.connect(dry); dry.connect(out);
  filt.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(out);
  out.connect(limiter);
  limiter.connect(masterGain);
  src.start();

  var node = {
    kind: "field", x: px, y: py, id: nodeIdCounter++,
    frozen: true, pruned: false, sizeScale: 1.3, quality: "field",
    filt: filt, delay: delay, fb: fb, out: out, strength: 0.5,
    stopField: function () {
      try { src.stop(); } catch (e) {}
      try {
        src.disconnect(); filt.disconnect(); delay.disconnect();
        fb.disconnect(); wet.disconnect(); dry.disconnect(); out.disconnect();
        limiter.disconnect();
      } catch (e) {}
    }
  };
  nodes.push(node);
  fieldNode = node;
  return node;
}

function captureFieldRecording() {
  initAudio();
  resumeAudio();
  var btn = document.getElementById("captureBtn");
  var original = itemTitle(btn);
  btn.disabled = true;
  setItemTitle(btn, "recording 3 seconds…");
  // Said once, the first time: the mic is only ever heard by this page.
  try {
    if (!localStorage.getItem("aeolaMicNoteShown")) {
      showToast("Recording 3 seconds — it stays on this device.", 3200);
      localStorage.setItem("aeolaMicNoteShown", "1");
    }
  } catch (e) {}
  btn.classList.add("recording");
  ensureMicStream()
    .then(function (stream) {
      return loadRecorderWorklet(audioCtx).then(function () { return stream; });
    })
    .then(function (stream) {
      var micSource = audioCtx.createMediaStreamSource(stream);
      var recorder = new AudioWorkletNode(audioCtx, "recorder-processor", { processorOptions: { seconds: 3 } });
      var silentSink = audioCtx.createGain();
      silentSink.gain.value = 0;
      micSource.connect(recorder);
      recorder.connect(silentSink);
      silentSink.connect(audioCtx.destination);
      recorder.port.onmessage = function (e) {
        if (!e.data || !e.data.done) return;
        micSource.disconnect();
        recorder.disconnect();
        silentSink.disconnect();
        releaseMic();
        var raw = e.data.buffer;
        for (var ci = 0; ci < raw.length; ci++) {
          if (raw[ci] > 1) raw[ci] = 1; else if (raw[ci] < -1) raw[ci] = -1;
        }
        crossfadeLoopSeam(raw, audioCtx.sampleRate);
        var buf = audioCtx.createBuffer(1, raw.length, audioCtx.sampleRate);
        buf.copyToChannel(raw, 0);
        spawnFieldNode(W * 0.5, H * 0.5, buf);
        track("field-recording");
        btn.disabled = false;
        setItemTitle(btn, original);
        btn.classList.remove("recording");
      };
    })
    .catch(function (err) {
      console.warn("Field recording could not start:", err);
      releaseMic();
      // Say what actually went wrong — "no mic found" used to cover every
      // failure, which hid the real cause on iOS.
      var name = err && err.name;
      track("field-recording-failed", { reason: name || "unknown" }); // tells us why, per platform
      var message;
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        message = "mic blocked — allow it for this site in Settings";
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        message = "no mic found";
      } else {
        message = "mic unavailable" + (name && name !== "Error" ? " (" + name + ")" : "");
      }
      setItemTitle(btn, message);
      btn.classList.remove("recording");
      setTimeout(function () {
        btn.disabled = false;
        setItemTitle(btn, original);
      }, 4000);
    });
}

// ── Export — bounces the actual master output (everything audible:
// every slider, drag, lock, weather change) to a downloadable MP3, for
// however long it runs.
//
// Encoded here in the browser, not on the server: it keeps working in
// airplane mode, the recording never leaves the device, and shared
// hosting rarely has an encoder anyway. The tap is an AudioWorklet that
// hands over raw stereo PCM in ~85ms chunks; LAME (lamejs, loaded only
// when export is first used) encodes each chunk as it arrives, so memory
// holds the finished MP3 rather than minutes of raw audio. If LAME can't
// load, or the device runs at a sample rate MP3 doesn't allow, it falls
// back to a WAV file — larger, but opens everywhere too.
var EXPORT_MP3_KBPS = 192;
var EXPORT_CHUNK_FRAMES = 4096;
var MP3_SAMPLE_RATES = [32000, 44100, 48000];
var exportSession = null;
var tapWorkletLoaded = null;
var lameLoaded = null;

var TAP_WORKLET_SRC = [
  "class TapProcessor extends AudioWorkletProcessor {",
  "  constructor(options) {",
  "    super();",
  "    this.size = (options && options.processorOptions && options.processorOptions.size) || 4096;",
  "    this.l = new Float32Array(this.size);",
  "    this.r = new Float32Array(this.size);",
  "    this.n = 0;",
  "    this.running = true;",
  "    var self = this;",
  "    this.port.onmessage = function (e) {",
  "      if (e.data === 'stop') { self.post(); self.running = false; self.port.postMessage({ done: true }); }",
  "    };",
  "  }",
  "  post() {",
  "    if (!this.n) return;",
  "    var l = this.l.slice(0, this.n), r = this.r.slice(0, this.n);",
  "    this.port.postMessage({ l: l, r: r }, [l.buffer, r.buffer]);",
  "    this.n = 0;",
  "  }",
  "  process(inputs) {",
  "    if (!this.running) return false;",
  "    var input = inputs[0];",
  "    var L = input && input[0], R = (input && input[1]) || L;",
  "    if (L) {",
  "      for (var i = 0; i < L.length; i++) {",
  "        this.l[this.n] = L[i]; this.r[this.n] = R[i]; this.n++;",
  "        if (this.n === this.size) this.post();",
  "      }",
  "    }",
  "    return true;",
  "  }",
  "}",
  "registerProcessor(\"tap-processor\", TapProcessor);"
].join("\n");

function loadTapWorklet(ctx) {
  if (tapWorkletLoaded) return tapWorkletLoaded;
  var blob = new Blob([TAP_WORKLET_SRC], { type: "application/javascript" });
  var url = URL.createObjectURL(blob);
  tapWorkletLoaded = ctx.audioWorklet.addModule(url).then(function () { URL.revokeObjectURL(url); });
  return tapWorkletLoaded;
}

function loadLame() {
  if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve(true);
  if (lameLoaded) return lameLoaded;
  lameLoaded = new Promise(function (resolve) {
    var script = document.createElement("script");
    script.src = "js/vendor/lame.min.js";
    script.onload = function () { resolve(!!(window.lamejs && window.lamejs.Mp3Encoder)); };
    script.onerror = function () { lameLoaded = null; resolve(false); };
    document.head.appendChild(script);
  });
  return lameLoaded;
}

function floatToInt16(src) {
  var out = new Int16Array(src.length);
  for (var i = 0; i < src.length; i++) {
    var v = Math.max(-1, Math.min(1, src[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

function makeMp3Sink(sampleRate) {
  var enc = new lamejs.Mp3Encoder(2, sampleRate, EXPORT_MP3_KBPS);
  var parts = [];
  return {
    ext: "mp3", type: "audio/mpeg",
    add: function (l, r) {
      var out = enc.encodeBuffer(floatToInt16(l), floatToInt16(r));
      if (out.length) parts.push(out);
    },
    finish: function () {
      var tail = enc.flush();
      if (tail.length) parts.push(tail);
      return new Blob(parts, { type: "audio/mpeg" });
    }
  };
}

function makeWavSink(sampleRate) {
  var parts = [], frames = 0;
  return {
    ext: "wav", type: "audio/wav",
    add: function (l, r) {
      var inter = new Float32Array(l.length * 2);
      for (var i = 0; i < l.length; i++) { inter[2 * i] = l[i]; inter[2 * i + 1] = r[i]; }
      parts.push(floatToInt16(inter));
      frames += l.length;
    },
    finish: function () {
      var dataBytes = frames * 4;
      var h = new DataView(new ArrayBuffer(44));
      var w = function (o, str) { for (var i = 0; i < str.length; i++) h.setUint8(o + i, str.charCodeAt(i)); };
      w(0, "RIFF"); h.setUint32(4, 36 + dataBytes, true); w(8, "WAVE");
      w(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 2, true);
      h.setUint32(24, sampleRate, true); h.setUint32(28, sampleRate * 4, true);
      h.setUint16(32, 4, true); h.setUint16(34, 16, true);
      w(36, "data"); h.setUint32(40, dataBytes, true);
      return new Blob([h].concat(parts), { type: "audio/wav" });
    }
  };
}

function exportFileName(ext) {
  var d = new Date();
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return "aeola-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "-" + pad(d.getHours()) + pad(d.getMinutes()) + "." + ext;
}

function downloadBlob(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
}

function flashExportBtn(text, ms) {
  var btn = document.getElementById("exportBtn");
  setItemTitle(btn, text);
  setTimeout(function () { setItemTitle(btn, "export MP3"); btn.disabled = false; }, ms || 1800);
}

function toggleMasterRecording() {
  var btn = document.getElementById("exportBtn");
  if (exportSession) {
    if (exportSession.stopping) return;
    exportSession.stopping = true;
    setItemTitle(btn, "encoding…");
    btn.disabled = true;
    exportSession.tap.port.postMessage("stop");
    return;
  }
  initAudio();
  resumeAudio();
  if (!audioCtx.audioWorklet) { flashExportBtn("not supported", 2200); return; }
  btn.disabled = true;
  var rate = audioCtx.sampleRate;
  Promise.all([loadTapWorklet(audioCtx), loadLame()]).then(function (res) {
    var sink = (res[1] && MP3_SAMPLE_RATES.indexOf(rate) !== -1) ? makeMp3Sink(rate) : makeWavSink(rate);
    var tap = new AudioWorkletNode(audioCtx, "tap-processor", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 2, channelCountMode: "explicit",
      processorOptions: { size: EXPORT_CHUNK_FRAMES }
    });
    // A worklet only runs while connected onward — a muted sink keeps it
    // pulling without adding anything to what you hear.
    var silent = audioCtx.createGain();
    silent.gain.value = 0;
    // Tapped AFTER the compressor — the same signal that reaches the
    // speakers, not the raw sum before the mix has been limited.
    compressor.connect(tap);
    tap.connect(silent);
    silent.connect(audioCtx.destination);
    exportSession = { tap: tap, sink: sink, stopping: false, startedAt: performance.now() };
    var session = exportSession;
    tap.port.onmessage = function (e) {
      if (e.data && e.data.l) { sink.add(e.data.l, e.data.r); return; }
      if (!e.data || !e.data.done) return;
      try { compressor.disconnect(tap); } catch (err) {}
      tap.disconnect();
      silent.disconnect();
      exportSession = null;
      btn.classList.remove("recording");
      track("export", { format: sink.ext, seconds: Math.round((performance.now() - session.startedAt) / 1000) });
      downloadBlob(sink.finish(), exportFileName(sink.ext));
      flashExportBtn("saved " + sink.ext + "!", 1800);
    };
    btn.disabled = false;
    btn.classList.add("recording");
    setItemTitle(btn, "stop and save");
  }).catch(function (err) {
    console.warn("Export could not start:", err);
    exportSession = null;
    flashExportBtn("not supported", 2200);
  });
}
