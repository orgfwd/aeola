# Aeola

**An instrument for finding what resonates with you.**
Hear what happens between notes: where they settle, where they clash.

**Try it:** https://aeola.vercel.app — free, no sign-up, works offline. Add it to your home screen for the full experience.

Tap to place a note (a small chord); position sets the pitch. Lock notes into drones and small synchroscopes appear between them, spinning at the real rate at which their overtones beat — and standing still when they lock. Switch "north" between the piano's tuning and pure ratios, let the notes drift, or hand the sky to live air traffic over Stockholm Arlanda or Cologne Bonn, each aircraft a note rising as it climbs.

A quiet homage to Brian Eno's *Music for Airports* — written for Cologne Bonn — and its tape loops of unequal length.

## Running it

No build step and no dependencies to install: the folder is the app.

```sh
python3 -m http.server
# then open http://localhost:8000
```

Opening `index.html` directly also works, apart from flight mode, which needs the small proxy in `api/flights.js` (a Vercel function) or `flights.php` (any PHP host).

If you deploy your own copy, remove the Umami analytics tag in `index.html` — it only counts visits on aeola.vercel.app, so it won't track yours, but it doesn't belong in someone else's site either.

## Structure

No build step. The folder is the app: upload it as-is.

| Path | What |
|---|---|
| `index.html` | Markup, head/preview tags, and the script tags in load order |
| `js/version.js` | `AEOLA_VERSION` — read by the page *and* the service worker |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline mode and home-screen install; `icons/og-image.png` is the link preview |
| `css/aeola.css` | All styles (mobile layout in the `max-width: 700px` block at the end) |
| `js/core.js` | DOM references, canvas sizing, note tables, shared constants |
| `js/audio.js` | Audio graph: master bus, weather FX, timbres, `playVoice` / `playChord` |
| `js/harmony.js` | Interval names and insights, **north** (tuning) and the pure-ratio maths |
| `js/capture.js` | Field recording (capture) and MP3 export (encoded in the browser) |
| `js/vendor/lame.min.js` | LAME MP3 encoder (lamejs 1.2.1, LGPL, unmodified; credited in the help card) |
| `js/room.js` | Notes in the room: zones, breathing, pitch mapping, `hit`, spawn, locks, collisions, `setNorth` |
| `js/drift.js`, `js/flight.js` | Autopilot modes |
| `js/synchroscope.js` | Beating physics and its instrument (see below) |
| `js/render.js` | Background, notes and ripples; the `draw()` loop |
| `js/chrome.js`, `js/panels.js`, `js/snapshot.js`, `js/input.js` | Menu open/close, help and toast; note and weather panels; snapshot/saved/share; pointer and keyboard |
| `js/coach.js` | First-run intro: tap → lock all → drift → open a note; advances when each is done; replayable from help |
| `js/main.js` | Button wiring and start-up; loads last |
| `api/flights.js` | Flight mode's live-traffic proxy, as a Vercel function (CDN-cached for 2 min) |
| `flights.php` | The same proxy for a plain PHP host (not deployed to Vercel; see `FLIGHT_ENDPOINT` in `js/flight.js`) |
| `vercel.json`, `.vercelignore` | Deploy config: no-cache on `sw.js` and `version.js`; `.vercelignore` is an allowlist of the files the app needs |

The scripts are classic `<script>` tags that share one global scope: a top-level `var` or `function` in any file is visible to the others. Order matters only for code that runs on load. Everything else is called later, from events or the draw loop. Keep new top-level names distinctive: a global named after a `window` property (`name`, `status`, `top`...) would clash.

## The menu

One menu for every screen (☰, top right), grouped by intent: autopilot, tuning, sound, see & learn, keep, and "clear the room" set apart at the end (it asks twice). Choices are segmented controls (`setSeg`/`bindSeg` in `main.js`) so every option is visible. ▶ drift and lock all live in the dock at the bottom, revealed once they mean something.

## The physics layer

- **North** (`harmony.js`). *Magnetic* = equal temperament (the piano). *True* = each chord's own tones at pure ratios above its root (5:4, 3:2...). Roots stay on the grid, so beating *between* notes stays, and some new beating appears (the comma). That's deliberate: no tuning settles everything at once. True north also scales vibrato and chorus detune by `TRUE_NORTH_STEADY`, because a pure ratio can only lock if the notes hold still.
- **Synchroscope** (`synchroscope.js`). It only reads the sound, it never changes it. It models each voice's harmonics from its timbre (oscillator shape plus filter), compares every harmonic between notes, and draws:
  - a spinning disc between two notes at the real beat rate;
  - a dashed ring around a chord whose own tones beat (it stops under true north);
  - a shaking line for roughness ("turbulence", from the Plomp–Levelt curve).

  Connectors between locked notes hold steady (a still green disc means "in sync"); any connector touching an unlocked note pulses with its sound. In flight mode everything pulses with the sound and only the four strongest pairs are drawn. Aircraft can't be dragged, unlocked or nudged.

- **Flight mode** (`flight.js`). Aircraft check in one at a time, nearest to the runway first (2.2–4 s apart), arrive soft and swell over a few strikes, and each repeats on its own fixed loop length (`FLIGHT_LOOP_MS`, prime-numbered tenths of a second) — tape loops of unequal length, so the room never falls back into step.

  Tuning knobs are at the top of the file: `BEAT_MAX_HZ`, the `ROUGH_*` thresholds, `SYNC_MAX_PAIRS`.

## Licence

> “As artists we don’t finish it: we start it. It goes on to have a life without us, a life we didn’t predict.”
> — Brian Eno & Bette Adriaanse, *What Art Does: An Unfinished Theory*

That's why Aeola is open.

Copyright © 2026 Alex Skepp.

Aeola is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License, version 3** (see `LICENSE`). In short: use it, learn from it, change it and share it — as long as what you share stays open under the same licence.

**The name "Aeola" and its icon are not covered by the licence.** Forks are welcome; please give yours its own name and icon, so nobody mistakes it for this one.

### Third-party

- **LAME MP3 encoder** — `js/vendor/lame.min.js` (lamejs 1.2.1), used unmodified under the LGPL; its licence is in `js/vendor/LICENSE-lamejs`.
- **Live flight data** — from [adsb.lol](https://www.adsb.lol), licensed ODbL 1.0; credited in the app's help card as "Live traffic from adsb.lol (ODbL)".

## Contributing

Ideas, bug reports and questions are very welcome — please open an issue.

For code, open an issue first so we can talk it through. By submitting a pull request you agree that your contribution may be distributed under GPL-3.0 **and**, by the copyright holder, under other terms — for example in a future App Store version of Aeola. That keeps the project open while leaving that door open too.
