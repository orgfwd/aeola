"use strict";

var helpBackdrop = document.getElementById("helpBackdrop");
var helpModalClose = document.getElementById("helpModalClose");
function openHelp() { helpBackdrop.classList.add("visible"); }
function closeHelp() { helpBackdrop.classList.remove("visible"); }
helpModalClose.addEventListener("click", closeHelp);
helpBackdrop.addEventListener("click", function (e) {
  if (e.target === helpBackdrop) closeHelp(); // a click on the backdrop, not the card
});

var menuBtn = document.getElementById("menuBtn");
var menuDrawer = document.getElementById("menuDrawer");
var menuScrim = document.getElementById("menuScrim");
var menuDrawerClose = document.getElementById("menuDrawerClose");
function setMenuOpen(open) {
  menuDrawer.classList.toggle("visible", open);
  menuScrim.classList.toggle("visible", open);
  menuDrawer.setAttribute("aria-hidden", open ? "false" : "true");
  menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open && typeof disarmClear === "function") disarmClear();
}
function openMenu() { setMenuOpen(true); coachNotify("menu"); }
function closeMenu() { setMenuOpen(false); }
function toggleMenu() {
  if (menuDrawer.classList.contains("visible")) closeMenu(); else openMenu();
}
menuBtn.addEventListener("click", toggleMenu);
menuDrawerClose.addEventListener("click", closeMenu);
menuScrim.addEventListener("click", closeMenu);
// Rows that open something else (weather, snapshot, help) close the menu
// first, so the two never stack on top of each other.
menuDrawer.addEventListener("click", function (e) {
  if (e.target.closest && e.target.closest("[data-closes-menu]")) closeMenu();
}, true);
document.getElementById("helpBtnMobile").addEventListener("click", openHelp);

var maxNodesToast = document.getElementById("maxNodesToast");
var maxNodesToastTimer = null;
var TOAST_DEFAULT = "All 8 notes are locked — unlock one to add another.";
function showToast(message, ms) {
  maxNodesToast.textContent = message;
  maxNodesToast.classList.add("visible");
  if (maxNodesToastTimer) clearTimeout(maxNodesToastTimer);
  maxNodesToastTimer = setTimeout(function () {
    maxNodesToast.classList.remove("visible");
    maxNodesToast.textContent = TOAST_DEFAULT;
  }, ms || 2600);
}
function showMaxNodesMessage() { showToast(TOAST_DEFAULT, 2600); }
