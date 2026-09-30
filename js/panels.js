"use strict";

var hasInteracted = false;
var activeDrag = null;
var editingNode = null;
var templateMode = false;

function makeTemplateNode() {
  return {
    template: true,
    frozen: false,
    timbre: "pure",
    color: "triad",
    vibrato: DEFAULT_VIBRATO,
    reverbSend: DEFAULT_REVERB,
    delaySend: DEFAULT_DELAY,
    stretch: DEFAULT_STRETCH
  };
}

function markInteracted() {
  if (!hasInteracted) {
    hasInteracted = true;
    hintEl.classList.add("hidden");
    document.querySelector(".wordmark").classList.add("hidden"); // steps aside with the intro text
  }
}

function updatePanelUI() {
  if (!editingNode) return;
  lockToggle.classList.toggle("on", !!editingNode.frozen);
  Array.prototype.forEach.call(timbreGroup.children, function (el) {
    el.classList.toggle("active", el.dataset.value === editingNode.timbre);
  });
  Array.prototype.forEach.call(colorGroup.children, function (el) {
    el.classList.toggle("active", el.dataset.value === editingNode.color);
  });
  vibratoSlider.value = Math.round(editingNode.vibrato * 100);
  reverbSlider.value = Math.round(editingNode.reverbSend * 100);
  delaySlider.value = Math.round(editingNode.delaySend * 100);
  stretchSlider.value = stretchToSlider(editingNode.stretch || DEFAULT_STRETCH);
}

function closeWeatherPanel() {
  weatherPanel.classList.remove("visible");
}

function openNodePanel(node) {
  if (node.kind === "field") { openFieldPanel(node); return; }
  coachNotify("panel");
  closeSnapshotPanel();
  closeWeatherPanel();
  templateMode = false;
  panelTitleEl.classList.remove("visible");
  editingNode = node;
  updatePanelUI();
  var margin = 12;
  nodePanel.style.visibility = "hidden";
  nodePanel.classList.add("visible");
  var rect = nodePanel.getBoundingClientRect();
  var px = clamp(node.x + 40, margin, W - rect.width - margin);
  var py = clamp(node.y - 60, margin, H - rect.height - margin);
  nodePanel.style.left = px + "px";
  nodePanel.style.top = py + "px";
  nodePanel.style.visibility = "";
}

function openTemplatePanel() {
  closeSnapshotPanel();
  closeWeatherPanel();
  templateMode = true;
  editingNode = makeTemplateNode();
  updatePanelUI();
  panelTitleEl.classList.add("visible");
  var margin = 12;
  nodePanel.style.visibility = "hidden";
  nodePanel.classList.add("visible");
  var rect = nodePanel.getBoundingClientRect();
  var anchor = pointerPos || { x: W / 2, y: H / 2 };
  var px = clamp(anchor.x + 40, margin, W - rect.width - margin);
  var py = clamp(anchor.y - 60, margin, H - rect.height - margin);
  nodePanel.style.left = px + "px";
  nodePanel.style.top = py + "px";
  nodePanel.style.visibility = "";
  markInteracted();
}

function closeNodePanel() {
  editingNode = null;
  templateMode = false;
  panelTitleEl.classList.remove("visible");
  nodePanel.classList.remove("visible");
  fieldPanel.classList.remove("visible");
}

function openFieldPanel(node) {
  closeSnapshotPanel();
  closeWeatherPanel();
  templateMode = false;
  nodePanel.classList.remove("visible");
  editingNode = node;
  fieldStrengthSlider.value = Math.round((node.strength != null ? node.strength : 0.5) * 100);
  var margin = 12;
  fieldPanel.style.visibility = "hidden";
  fieldPanel.classList.add("visible");
  var rect = fieldPanel.getBoundingClientRect();
  var px = clamp(node.x + 40, margin, W - rect.width - margin);
  var py = clamp(node.y - 60, margin, H - rect.height - margin);
  fieldPanel.style.left = px + "px";
  fieldPanel.style.top = py + "px";
  fieldPanel.style.visibility = "";
}

function previewNode(node) {
  if (!node || node.pruned || node.template || !audioCtx) return;
  if (node.timerId) clearTimeout(node.timerId);
  hit(node, node.lastGain || 0.85);
}

function isNodeAudibleNow(node) {
  if (!node || node.pruned || !audioCtx || node.lastHitStart == null) return false;
  var elapsed = audioCtx.currentTime - node.lastHitStart;
  return elapsed >= 0 && elapsed < TOTAL * (node.stretch || 1) + 0.15;
}

function applyLiveSettings(node) {
  if (!node || !node.activeVoices) return;
  var now = audioCtx.currentTime;
  var vibratoTarget = lerp(0, 35, node.vibrato || 0) * northSteadiness();
  node.activeVoices.forEach(function (voice) {
    applyTimbreToVoice(voice, node.timbre);
    voice.vibratoDepths.forEach(function (vd) { vd.gain.setTargetAtTime(vibratoTarget, now, 0.03); });
    voice.delaySendGain.gain.setTargetAtTime(0.7 * (node.delaySend || 0), now, 0.05);
    voice.reverbSendGain.gain.setTargetAtTime(1.1 * (node.reverbSend || 0), now, 0.05);
  });
}

function reflectSettingChange(node) {
  if (!node || node.pruned) return;
  if (isNodeAudibleNow(node)) {
    applyLiveSettings(node);
  } else {
    var now = performance.now();
    if (!node.lastPreviewAt || now - node.lastPreviewAt > 260) {
      node.lastPreviewAt = now;
      previewNode(node);
    }
  }
}

fieldPanelClose.addEventListener("click", closeNodePanel);
fieldStrengthSlider.addEventListener("input", function () {
  if (!editingNode || editingNode.kind !== "field") return;
  var strength = fieldStrengthSlider.value / 100;
  editingNode.strength = strength;
  if (editingNode.out && audioCtx) {
    var fnow = audioCtx.currentTime;
    editingNode.out.gain.cancelScheduledValues(fnow);
    editingNode.out.gain.linearRampToValueAtTime(strength, fnow + 0.05);
  }
});
fieldRemoveBtn.addEventListener("click", function () {
  closeNodePanel();
  removeFieldNode();
});

lockToggle.addEventListener("click", function () {
  if (!editingNode) return;
  toggleFreeze(editingNode);
  updatePanelUI();
});
timbreGroup.addEventListener("click", function (e) {
  var el = e.target.closest ? e.target.closest(".pill") : null;
  if (!el || !editingNode) return;
  editingNode.timbre = el.getAttribute("data-value");
  updatePanelUI();
  reflectSettingChange(editingNode);
});
colorGroup.addEventListener("click", function (e) {
  var el = e.target.closest ? e.target.closest(".pill") : null;
  if (!el || !editingNode) return;
  editingNode.color = el.getAttribute("data-value");
  updatePanelUI();
  previewNode(editingNode);
});
vibratoSlider.addEventListener("input", function () {
  if (!editingNode) return;
  editingNode.vibrato = vibratoSlider.value / 100;
  reflectSettingChange(editingNode);
});
reverbSlider.addEventListener("input", function () {
  if (!editingNode) return;
  editingNode.reverbSend = reverbSlider.value / 100;
  reflectSettingChange(editingNode);
});
delaySlider.addEventListener("input", function () {
  if (!editingNode) return;
  editingNode.delaySend = delaySlider.value / 100;
  reflectSettingChange(editingNode);
});
stretchSlider.addEventListener("input", function () {
  if (!editingNode) return;
  editingNode.stretch = sliderToStretch(stretchSlider.value);
  // Dragging fires many 'input' events per second. Every other slider goes
  // through reflectSettingChange's 260ms throttle; this one called
  // previewNode() directly, so a fast drag could spawn dozens of
  // overlapping voice graphs (each living up to ~11s at max stretch) and
  // stall the audio thread. Same throttle, applied here too.
  var now = performance.now();
  if (!editingNode.lastPreviewAt || now - editingNode.lastPreviewAt > 260) {
    editingNode.lastPreviewAt = now;
    previewNode(editingNode);
  }
});
nodePanelClose.addEventListener("click", closeNodePanel);

revealToggle.addEventListener("click", function () {
  revealEnabled = !revealEnabled;
  revealToggle.classList.toggle("on", revealEnabled);
  revealToggle.setAttribute("aria-checked", revealEnabled ? "true" : "false");
});

gridToggle.addEventListener("click", function () {
  gridVisible = !gridVisible;
  gridToggle.classList.toggle("on", gridVisible);
  gridToggle.setAttribute("aria-checked", gridVisible ? "true" : "false");
});



function updateWeatherAudio() {
  if (!audioCtx) return;
  var now = audioCtx.currentTime;
  var reverbTarget = weatherEnabled ? (weatherReverbSlider.value / 100) * 1.3 : 0;
  var distTarget = weatherEnabled ? (weatherDistSlider.value / 100) : 0;
  var phaseTarget = weatherEnabled ? (weatherPhaseSlider.value / 100) * 1.3 : 0;
  weatherReverbSend.gain.setTargetAtTime(reverbTarget, now, 0.25);
  weatherDistSend.gain.setTargetAtTime(distTarget, now, 0.25);
  weatherPhaseSend.gain.setTargetAtTime(phaseTarget, now, 0.25);
}

weatherBtn.addEventListener("click", function () {
  initAudio();
  closeNodePanel();
  closeSnapshotPanel();
  weatherPanel.classList.toggle("visible");
  markInteracted();
});
weatherPanelClose.addEventListener("click", closeWeatherPanel);
weatherToggle.addEventListener("click", function () {
  weatherEnabled = !weatherEnabled;
  if (weatherEnabled) track("weather-on");
  weatherToggle.classList.toggle("on", weatherEnabled);
  updateWeatherAudio();
});
[weatherReverbSlider, weatherDistSlider, weatherPhaseSlider].forEach(function (slider) {
  slider.addEventListener("input", updateWeatherAudio);
});
