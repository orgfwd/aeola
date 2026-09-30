"use strict";

function makeImpulse(ctx, duration, decay) {
  var rate = ctx.sampleRate;
  var length = Math.max(1, Math.floor(rate * duration));
  var impulse = ctx.createBuffer(2, length, rate);
  for (var ch = 0; ch < 2; ch++) {
    var data = impulse.getChannelData(ch);
    for (var i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function makeSoftClipCurve(amount) {
  var k = amount || 8, n = 8192;
  var curve = new Float32Array(n);
  var norm = Math.tanh(k) || 1;
  for (var i = 0; i < n; i++) {
    var x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

// Slow 4-stage allpass phaser, L/R chains driven by an inverted LFO pair for stereo drift.
function buildStereoPhaser(ctx) {
  var input = ctx.createGain();
  var leftIn = ctx.createGain(), rightIn = ctx.createGain();
  input.connect(leftIn);
  input.connect(rightIn);

  var lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.1;
  var depth = ctx.createGain();
  depth.gain.value = 850;
  var depthInv = ctx.createGain();
  depthInv.gain.value = -850;
  lfo.connect(depth);
  lfo.connect(depthInv);
  lfo.start();

  function chain(node, depthNode) {
    var prev = node, stages = 4;
    for (var i = 0; i < stages; i++) {
      var ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = 900;
      ap.Q.value = 0.6;
      depthNode.connect(ap.frequency);
      prev.connect(ap);
      prev = ap;
    }
    return prev;
  }

  var leftOut = chain(leftIn, depth);
  var rightOut = chain(rightIn, depthInv);
  var output = ctx.createGain();

  if (ctx.createStereoPanner) {
    var leftPan = ctx.createStereoPanner();
    var rightPan = ctx.createStereoPanner();
    leftPan.pan.value = -1;
    rightPan.pan.value = 1;
    leftOut.connect(leftPan);
    rightOut.connect(rightPan);
    leftPan.connect(output);
    rightPan.connect(output);
  } else {
    leftOut.connect(output);
    rightOut.connect(output);
  }

  return { input: input, output: output };
}

var PITCH_SHIFT_WORKLET_SRC = [
  "class PitchShiftProcessor extends AudioWorkletProcessor {",
  "  constructor(options) {",
  "    super();",
  "    var opts = (options && options.processorOptions) || {};",
  "    this.ratio = opts.ratio || 2.0;",
  "    this.grainSize = Math.max(256, Math.floor(sampleRate * ((opts.grainMs || 90) / 1000)));",
  "    this.bufSize = this.grainSize * 4;",
  "    this.buffer = new Float32Array(this.bufSize);",
  "    this.writeIndex = 0;",
  "    this.readIndexA = this.bufSize - this.grainSize * 2;",
  "    this.readIndexB = this.readIndexA + this.grainSize / 2;",
  "    this.prevPosA = 0;",
  "    this.prevPosB = this.grainSize / 2;",
  "    var self = this;",
  "    this.port.onmessage = function (e) {",
  "      if (e.data && typeof e.data.ratio === \"number\") self.ratio = e.data.ratio;",
  "    };",
  "  }",
  "  readInterp(idx) {",
  "    var buf = this.buffer, n = buf.length;",
  "    var i0 = Math.floor(idx) % n;",
  "    if (i0 < 0) i0 += n;",
  "    var i1 = (i0 + 1) % n;",
  "    var frac = idx - Math.floor(idx);",
  "    return buf[i0] * (1 - frac) + buf[i1] * frac;",
  "  }",
  "  advance(key, prevKey) {",
  "    var n = this.bufSize, g = this.grainSize;",
  "    this[key] += this.ratio;",
  "    var pos = ((this[key] % g) + g) % g;",
  "    if (pos < this[prevKey]) {",
  "      var lookback = g * 2;",
  "      this[key] = (((this.writeIndex - lookback) % n) + n) % n + pos;",
  "    }",
  "    this[prevKey] = pos;",
  "    var win = Math.sin(Math.PI * (pos / g));",
  "    return { sample: this.readInterp(this[key]), win: win };",
  "  }",
  "  process(inputs, outputs) {",
  "    var input = inputs[0][0];",
  "    var output = outputs[0][0];",
  "    if (!output) return true;",
  "    var buf = this.buffer, n = this.bufSize;",
  "    for (var i = 0; i < output.length; i++) {",
  "      var s = input ? input[i] : 0;",
  "      buf[this.writeIndex] = s;",
  "      this.writeIndex = (this.writeIndex + 1) % n;",
  "      var a = this.advance(\"readIndexA\", \"prevPosA\");",
  "      var b = this.advance(\"readIndexB\", \"prevPosB\");",
  "      var wsum = a.win + b.win;",
  "      output[i] = wsum > 0.0001 ? (a.sample * a.win + b.sample * b.win) / wsum : 0;",
  "    }",
  "    return true;",
  "  }",
  "}",
  "registerProcessor(\"pitch-shift-processor\", PitchShiftProcessor);"
].join("\n");

function loadPitchShiftWorklet(ctx) {
  var blob = new Blob([PITCH_SHIFT_WORKLET_SRC], { type: "application/javascript" });
  var url = URL.createObjectURL(blob);
  return ctx.audioWorklet.addModule(url).then(function () {
    URL.revokeObjectURL(url);
  });
}

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1;
  compressor = audioCtx.createDynamicsCompressor();
  compressor.connect(audioCtx.destination);

  // The weather bus collects the dry mix plus the existing delay/reverb tails, so
  // master effects below can act on "the whole chain" rather than just dry voices.
  weatherBus = audioCtx.createGain();
  weatherBus.gain.value = 1;

  delayNode = audioCtx.createDelay(2.0);
  delayNode.delayTime.value = 0.38;
  feedbackGain = audioCtx.createGain();
  feedbackGain.gain.value = 0.34;
  wetGain = audioCtx.createGain();
  wetGain.gain.value = 0.85;
  delayNode.connect(feedbackGain);
  feedbackGain.connect(delayNode);
  delayNode.connect(wetGain);
  wetGain.connect(weatherBus);

  reverbNode = audioCtx.createConvolver();
  reverbNode.buffer = makeImpulse(audioCtx, 2.6, 2.4);
  reverbOutGain = audioCtx.createGain();
  reverbOutGain.gain.value = 1.1;
  reverbNode.connect(reverbOutGain);
  reverbOutGain.connect(weatherBus);

  masterGain.connect(weatherBus);

  // --- Weather master-bus FX: real pitch-shifted shimmer, saturated
  // distortion, phaser ---
  // Shimmer used to be a long reverb with a slowly modulated high-shelf —
  // it never produced actual shimmer character (small, high-pitched tails)
  // no matter how loud it was turned up, because nothing in that chain
  // actually shifted pitch. This version runs the send through a real
  // delay-line pitch-shifter (an AudioWorklet, +1 octave), then a long
  // reverb to smooth the shifter's grain artifacts into a tail, with a
  // feedback path (through a lowpass, to stop the pitch from climbing
  // into harshness over many passes) so the shimmer keeps regenerating
  // rather than decaying once. Worklet loading is async — everything here
  // is built the moment it resolves; if it fails to load in some browser,
  // shimmer is silently just off rather than breaking the rest of the app.
  weatherReverbSend = audioCtx.createGain();
  weatherReverbSend.gain.value = 0;
  masterGain.connect(weatherReverbSend);

  loadPitchShiftWorklet(audioCtx).then(function () {
    var shimmerMixIn = audioCtx.createGain();
    shimmerMixIn.gain.value = 1;
    var pitchShift = new AudioWorkletNode(audioCtx, "pitch-shift-processor", {
      processorOptions: { ratio: 2.0, grainMs: 90 }
    });
    var shimmerConvolver = audioCtx.createConvolver();
    shimmerConvolver.buffer = makeImpulse(audioCtx, 5.5, 1.6);
    var shimmerFeedbackFilter = audioCtx.createBiquadFilter();
    shimmerFeedbackFilter.type = "lowpass";
    shimmerFeedbackFilter.frequency.value = 7000;
    shimmerFeedbackFilter.Q.value = 0.3;
    var shimmerFeedbackGain = audioCtx.createGain();
    shimmerFeedbackGain.gain.value = 0.38;
    var shimmerReturn = audioCtx.createGain();
    shimmerReturn.gain.value = 1.6;

    weatherReverbSend.connect(shimmerMixIn);
    shimmerMixIn.connect(pitchShift);
    pitchShift.connect(shimmerConvolver);
    shimmerConvolver.connect(shimmerFeedbackFilter);
    shimmerFeedbackFilter.connect(shimmerReturn);
    shimmerFeedbackFilter.connect(shimmerFeedbackGain);
    shimmerFeedbackGain.connect(shimmerMixIn);
    shimmerReturn.connect(weatherBus);
  }).catch(function (e) {
    console.warn("Shimmer pitch-shifter failed to load — shimmer is off:", e);
  });

  weatherDistSend = audioCtx.createGain();
  weatherDistSend.gain.value = 0;
  masterGain.connect(weatherDistSend);
  var distDrive = audioCtx.createGain();
  distDrive.gain.value = 2.2;
  var shaper = audioCtx.createWaveShaper();
  shaper.curve = makeSoftClipCurve(4.5);
  shaper.oversample = "4x";
  var distTone = audioCtx.createBiquadFilter();
  distTone.type = "lowpass";
  distTone.frequency.value = 3200;
  distTone.Q.value = 0.5;
  // Distortion gets its own compressor so cranking the slider adds harmonic
  // character rather than raw loudness. Previously the shared master
  // compressor was the only thing taming it, so a hot distortion send
  // ducked the whole mix instead of just itself.
  var distCompressor = audioCtx.createDynamicsCompressor();
  distCompressor.threshold.value = -24;
  distCompressor.knee.value = 12;
  distCompressor.ratio.value = 8;
  distCompressor.attack.value = 0.003;
  distCompressor.release.value = 0.15;
  var distReturn = audioCtx.createGain();
  distReturn.gain.value = 0.65;
  weatherDistSend.connect(distDrive);
  distDrive.connect(shaper);
  shaper.connect(distTone);
  distTone.connect(distCompressor);
  distCompressor.connect(distReturn);
  distReturn.connect(weatherBus);

  weatherPhaseSend = audioCtx.createGain();
  weatherPhaseSend.gain.value = 0;
  weatherBus.connect(weatherPhaseSend);
  var phaser = buildStereoPhaser(audioCtx);
  weatherPhaseSend.connect(phaser.input);
  var phaseReturn = audioCtx.createGain();
  phaseReturn.gain.value = 2.0;
  phaser.output.connect(phaseReturn);

  weatherBus.connect(compressor);
  phaseReturn.connect(compressor);
}

function resumeAudio() {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  claimPlaybackSession();
}

// ── The iPhone ring/silent switch. By default iOS files Web Audio under
// "ambient" sound — the kind the silent switch mutes, like a game's
// effects. Aeola is an instrument, and phones sit on silent exactly
// where it was meant to be used (a plane seat), so it asks to be treated
// as "playback", the category music players use, which ignores the
// switch. Two routes, because iOS changed how:
//   - Safari 17.4+: navigator.audioSession.type = "playback", official.
//   - Older iOS: a playing HTML <audio> element moves the whole page's
//     session to playback, and Web Audio follows it. The element loops a
//     quarter-second of silence, generated here, so there's no file.
// Both have to happen inside a tap, which is where resumeAudio() runs.
var playbackKeeper = null;
// While the microphone records, iOS needs "play-and-record" instead: the
// "playback" category switches audio input off entirely, so the mic comes
// back as unavailable. resumeAudio() runs on every note strike, which is
// why the choice is made here rather than set once — it would otherwise
// flip back to "playback" mid-recording.
var micInUse = false;

function claimPlaybackSession() {
  var wanted = micInUse ? "play-and-record" : "playback";
  try {
    if (navigator.audioSession && navigator.audioSession.type !== wanted) navigator.audioSession.type = wanted;
  } catch (e) {}
  if (!playbackKeeper) {
    playbackKeeper = document.createElement("audio");
    playbackKeeper.setAttribute("playsinline", "");
    playbackKeeper.setAttribute("x-webkit-airplay", "deny");
    playbackKeeper.loop = true;
    playbackKeeper.src = URL.createObjectURL(makeSilentWav(0.25));
  }
  if (playbackKeeper.paused) {
    var attempt = playbackKeeper.play();
    if (attempt && attempt.catch) attempt.catch(function () {}); // not inside a tap yet — the next one retries
  }
}

function makeSilentWav(seconds) {
  var rate = 8000, frames = Math.floor(rate * seconds), bytes = frames * 2;
  var v = new DataView(new ArrayBuffer(44 + bytes));
  var w = function (o, str) { for (var i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + bytes, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, bytes, true);
  return new Blob([v], { type: "audio/wav" });
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clampFreq(f) { return Math.max(200, Math.min(6000, f)); }

function scheduleEnvelope(gainNode, startTime, peak, stretch) {
  var s = stretch || 1;
  var a = ATTACK * s, sus = SUSTAIN * s, r = RELEASE * s;
  var g = gainNode.gain;
  g.cancelScheduledValues(startTime);
  g.setValueAtTime(0.0001, startTime);
  g.linearRampToValueAtTime(peak, startTime + a);
  g.setValueAtTime(peak, startTime + a + sus);
  g.linearRampToValueAtTime(0.0001, startTime + a + sus + r);
}

// detune: cents between the two main oscillators in a voice. Added
// alongside "cold"/"rich" below — the four original timbres all keep
// their existing ±6, unchanged, since playVoice previously hardcoded
// that value rather than reading it per timbre.
var TIMBRE_CONFIG = {
  pure: { filterType: "allpass", filterFreq: 8000, filterQ: 0.0001, oscType: "sine", sub: false, detune: 6 },
  warm: { filterType: "lowpass", filterFreq: 950, filterQ: 0.6, oscType: "sine", sub: true, detune: 6 },
  resonant: { filterType: "bandpass", filterFreq: null, filterQ: 9, oscType: "sawtooth", sub: false, detune: 6 },
  nasal: { filterType: "bandpass", filterFreq: 1350, filterQ: 10, oscType: "sawtooth", sub: false, detune: 6 },
  // Arlanda's voice, designed in tools/synth-lab.html. "Cold" read as
  // icy and sharp (sawtooth through a highpass) rather than plain and
  // pure, which is all a sine would give. Filter Q is kept gentle: a
  // resonant Q around 10 would ring as a near-whistle at ~1.2 kHz,
  // especially under heavy reverb and a long delay tail, so the highpass
  // thins the sound without singing its own note. Tight detune for a
  // clean, unwavering edge; no sub, so it stays thin rather than warm.
  cold: { filterType: "highpass", filterFreq: 900, filterQ: 0.6, oscType: "sawtooth", sub: false, detune: 3 },
  // Cologne's voice. "Rich" through width and movement — a triangle with
  // wide detune, a nod to the tape-loop phasing Music for Airports is
  // built on — rather than through raw harmonic content. Warmth comes from
  // the sub (on/off only in this engine) and a lowpass; a notch filter was
  // tried, but Cologne's weather preset already turns the real phaser up,
  // so the filter is free to do what filters do best for warmth.
  rich: { filterType: "lowpass", filterFreq: 1100, filterQ: 2.5, oscType: "triangle", sub: true, detune: 16 }
};

function timbreFilterFreq(timbre, freq) {
  var cfg = TIMBRE_CONFIG[timbre] || TIMBRE_CONFIG.pure;
  return cfg.filterType === "bandpass" && timbre === "resonant" ? clampFreq(freq * 2.5) : cfg.filterFreq;
}

function applyTimbreToVoice(voice, timbre) {
  var cfg = TIMBRE_CONFIG[timbre] || TIMBRE_CONFIG.pure;
  var now = audioCtx.currentTime;
  voice.oscillators.forEach(function (osc) { osc.type = cfg.oscType; });
  voice.filter.type = cfg.filterType;
  voice.filter.frequency.setTargetAtTime(timbreFilterFreq(timbre, voice.freq), now, 0.02);
  voice.filter.Q.setTargetAtTime(cfg.filterQ, now, 0.02);
  voice.subGain.gain.setTargetAtTime(cfg.sub ? 0.5 : 0, now, 0.03);
}

function playVoice(freq, startTime, pan, peak, offset, voiceParams) {
  var stretch = voiceParams.stretch || 1;
  var voiceGain = audioCtx.createGain();
  var panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
  scheduleEnvelope(voiceGain, startTime, peak, stretch);

  var stopTime = startTime + TOTAL * stretch + 0.2;
  var timbre = voiceParams.timbre || "pure";

  var filter = audioCtx.createBiquadFilter();
  filter.type = TIMBRE_CONFIG[timbre].filterType;
  filter.frequency.value = timbreFilterFreq(timbre, freq) * (voiceParams.filterFreqMult || 1);
  filter.Q.value = TIMBRE_CONFIG[timbre].filterQ;
  filter.connect(voiceGain);
  var voiceInput = filter;

  var oscillators = [];
  var vibratoDepths = [];
  var vibratoAmount = voiceParams.vibrato || 0;
  var detuneSpread = TIMBRE_CONFIG[timbre].detune != null ? TIMBRE_CONFIG[timbre].detune : 6;
  var steady = northSteadiness();
  var wobble = voiceParams.detuneWobble || 0;
  [-detuneSpread, detuneSpread].forEach(function (cents) {
    var osc = audioCtx.createOscillator();
    osc.type = TIMBRE_CONFIG[timbre].oscType;
    osc.frequency.value = freq;
    osc.detune.value = cents * steady + wobble;
    osc._chorusCents = cents; // unscaled, so a change of north can rescale it live

    var vibrato = audioCtx.createOscillator();
    vibrato.type = "sine";
    vibrato.frequency.value = 4.2 + Math.random() * 1.6;
    var vibratoDepth = audioCtx.createGain();
    vibratoDepth.gain.value = lerp(0, 35, vibratoAmount) * steady;
    vibrato.connect(vibratoDepth);
    vibratoDepth.connect(osc.detune);
    vibrato.start(startTime);
    vibrato.stop(stopTime);
    vibratoDepths.push(vibratoDepth);

    osc.connect(voiceInput);
    osc.start(startTime);
    osc.stop(stopTime);
    oscillators.push(osc);
  });

  var sub = audioCtx.createOscillator();
  sub.type = "sine";
  sub.frequency.value = freq / 2;
  var subGain = audioCtx.createGain();
  subGain.gain.value = TIMBRE_CONFIG[timbre].sub ? 0.5 : 0;
  sub.connect(subGain);
  subGain.connect(voiceInput);
  sub.start(startTime);
  sub.stop(stopTime);

  var dryDest;
  if (panner) {
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    voiceGain.connect(panner);
    dryDest = panner;
  } else {
    dryDest = voiceGain;
  }
  dryDest.connect(masterGain);

  var delaySendGain = audioCtx.createGain();
  delaySendGain.gain.value = 0.7 * (voiceParams.delaySend || 0);
  if (delayNode) {
    dryDest.connect(delaySendGain);
    delaySendGain.connect(delayNode);
  }
  var reverbSendGain = audioCtx.createGain();
  reverbSendGain.gain.value = 1.1 * (voiceParams.reverbSend || 0);
  if (reverbNode) {
    dryDest.connect(reverbSendGain);
    reverbSendGain.connect(reverbNode);
  }

  return {
    panner: panner, offset: offset, freq: freq, sub: sub, wobble: wobble,
    vibratoAmount: vibratoAmount, timbre: timbre,
    oscillators: oscillators, filter: filter, subGain: subGain,
    vibratoDepths: vibratoDepths, delaySendGain: delaySendGain, reverbSendGain: reverbSendGain
  };
}

function playChord(node, startTime, peak, breath) {
  var b = breath || {};
  var intervals = colorIntervals(node.color, node.quality);
  var n = intervals.length;
  var voiceParams = {
    timbre: node.timbre,
    vibrato: clamp((node.vibrato || 0) + (b.vibratoDelta || 0), 0, 1),
    reverbSend: node.reverbSend, delaySend: node.delaySend,
    stretch: (node.stretch || 1) * (b.stretchMult || 1),
    filterFreqMult: b.filterFreqMult || 1,
    detuneWobble: b.detuneWobble || 0
  };
  return intervals.map(function (semi, i) {
    var spread = n > 1 ? (i / (n - 1) - 0.5) * 0.5 : 0;
    var voice = playVoice(chordToneFreq(node.rootMidi, semi), startTime, node.pan + spread, peak, spread, voiceParams);
    voice.semi = semi;
    return voice;
  });
}

function playCollisionChime(mx) {
  if (!audioCtx) return;
  resumeAudio();
  var t0 = audioCtx.currentTime + 0.01;
  var freq = 1100 + Math.random() * 500;
  var osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.3, t0 + 0.12);
  var filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2200;
  filter.Q.value = 0.4;
  var g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(0.1, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
  osc.connect(filter);
  filter.connect(g);
  var panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
  var dryDest;
  if (panner) {
    panner.pan.value = clamp((mx / W - 0.5) * 1.6, -1, 1);
    g.connect(panner);
    dryDest = panner;
  } else {
    dryDest = g;
  }
  dryDest.connect(masterGain);
  if (delayNode) {
    var delaySend = audioCtx.createGain();
    delaySend.gain.value = 0.22;
    dryDest.connect(delaySend);
    delaySend.connect(delayNode);
  }
  if (reverbNode) {
    var reverbSend = audioCtx.createGain();
    reverbSend.gain.value = 0.32;
    dryDest.connect(reverbSend);
    reverbSend.connect(reverbNode);
  }
  osc.start(t0);
  osc.stop(t0 + 0.6);
}
