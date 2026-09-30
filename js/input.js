"use strict";

window.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    if (helpBackdrop.classList.contains("visible")) { closeHelp(); return; }
    if (menuDrawer.classList.contains("visible")) { closeMenu(); return; }
    if (templateMode) closeNodePanel();
    return;
  }
  if (e.code !== "Space" && e.key !== " ") return;
  var tag = document.activeElement ? document.activeElement.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
  if (templateMode) {
    closeNodePanel();
    return;
  }
  closeNodePanel();
  openTemplatePanel();
});

canvas.addEventListener("pointerdown", function (e) {
  initAudio();
  resumeAudio();
  var x = e.clientX, y = e.clientY;
  var hitNode = findNodeAt(x, y);
  if (editingNode && editingNode !== hitNode) {
    // A click outside an open panel only closes it — it doesn't also count
    // as "place a new note here". That waits for the next click, once the
    // panel is gone.
    closeNodePanel();
    return;
  }
  if (hitNode && hitNode._flightId) {
    // Aircraft fly themselves: never dragged, and no settings panel either
    // (its lock switch could unlock one, and it would decay out of the sky).
    showToast(hitNode._flightCall + " flies itself — aircraft can't be moved.", 2200);
    markInteracted();
    return;
  }
  var template = (templateMode && !hitNode) ? editingNode : null;

  var node = hitNode || spawnNode(x, y, template);
  if (!node) {
    // The room is full of locked notes — spawnNode has already shown the
    // message. Nothing to drag, so stop without setting activeDrag.
    markInteracted();
    return;
  }
  activeDrag = {
    node: node,
    pointerId: e.pointerId,
    startX: node.x, startY: node.y,
    moved: false,
    justSpawned: !hitNode,
    moveThreshold: e.pointerType === "touch" ? 16 : MOVE_THRESHOLD
  };
  if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
  markInteracted();
});

canvas.addEventListener("pointermove", function (e) {
  pointerPos = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointerleave", function () {
  pointerPos = null;
});

canvas.addEventListener("pointermove", function (e) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  var dx = e.clientX - activeDrag.startX, dy = e.clientY - activeDrag.startY;
  if (!activeDrag.moved && Math.sqrt(dx * dx + dy * dy) > activeDrag.moveThreshold) {
    activeDrag.moved = true;
  }
  if (activeDrag.moved && !activeDrag.justSpawned) {
    updateNodePosition(activeDrag.node, e.clientX, e.clientY);
  }
});

function endDrag(e) {
  if (e.pointerType !== "mouse") pointerPos = null;
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  if (activeDrag.justSpawned) {
    var dx = e.clientX - activeDrag.startX, dy = e.clientY - activeDrag.startY;
    commitSpawn(activeDrag.node, Math.sqrt(dx * dx + dy * dy));
  } else if (!activeDrag.moved) {
    openNodePanel(activeDrag.node);
  }
  activeDrag = null;
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
