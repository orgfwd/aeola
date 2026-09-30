// Aeola "flight mode" proxy — the Vercel port of flights.php (same output,
// same logic; see that file for the full reasoning behind each choice).
//
// Why a server at all: adsb.lol sends no CORS header, so a browser can't
// call it directly. This trims each aircraft to the 12 fields Aeola uses.
// Caching moves from a temp file to Vercel's CDN: s-maxage lets one
// upstream call serve every visitor for two minutes, and
// stale-while-revalidate keeps serving the last good sky while a refresh
// is in flight — a stale sky beats an empty one.
//
// Airports are a fixed allowlist so this can't be used as an open proxy.
// Data: adsb.lol, licensed ODbL 1.0 — credited in the help card as
// "Live traffic from adsb.lol (ODbL)".

const CACHE_TTL = 120;      // seconds — matches the client's poll interval
const UPSTREAM_TMO = 8000;  // ms
const MAX_AIRCRAFT = 24;    // the client shows 8; a small surplus covers filtering

const AIRPORTS = {
  essa: { name: "Stockholm Arlanda", lat: 59.6519, lon: 17.9186, dist: 40 },
  eddk: { name: "Cologne Bonn", lat: 50.8659, lon: 7.1427, dist: 40 }
};

// ICAO operator prefixes of the major cargo airlines likely near either airport.
const CARGO_PREFIXES = ["UPS", "FDX", "GTI", "GEC", "CLX", "CLI", "CKS", "ABW", "BOX", "BCS", "CAO", "SQC", "MPH"];

function isCargo(callsign) {
  return CARGO_PREFIXES.includes(callsign.trim().slice(0, 3).toUpperCase());
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const r = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const key = String((req.query && req.query.ap) || "essa").trim().toLowerCase();
  const ap = AIRPORTS[key];
  if (!ap) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "unknown airport", valid: Object.keys(AIRPORTS) }));
  }

  const url = `https://api.adsb.lol/v2/lat/${ap.lat.toFixed(4)}/lon/${ap.lon.toFixed(4)}/dist/${ap.dist}`;
  let data;
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Aeola/1.0 (ambient instrument; https://aeola.vercel.app)" },
      signal: AbortSignal.timeout(UPSTREAM_TMO)
    });
    if (!upstream.ok) throw new Error("HTTP " + upstream.status);
    data = await upstream.json();
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ error: "upstream unavailable" }));
  }

  const aircraft = [];
  for (const a of (data && data.ac) || []) {
    if (a.lat == null || a.lon == null) continue;
    // alt_baro is a number when airborne but the literal string "ground" when not.
    const onGround = a.alt_baro === "ground";
    const altFt = onGround ? 0 : Number(a.alt_baro) || 0;
    const speed = Number(a.gs) || 0;
    const hex = String(a.hex || "");
    const call = String(a.flight || "").trim();
    aircraft.push({
      id: hex,
      call: call || hex.toUpperCase(),
      lat: round(+a.lat, 4),
      lon: round(+a.lon, 4),
      alt: Math.round(Math.max(0, altFt)),
      gs: round(speed, 1),
      trk: round(Number(a.track) || 0, 1),
      rate: Math.round(Number(a.baro_rate) || 0),
      type: String(a.t || ""),
      gnd: onGround || speed < 30,
      cargo: isCargo(call),
      dist: distanceKm(+a.lat, +a.lon, ap.lat, ap.lon)
    });
  }
  // Nearest first, so "an airport's sky" means the traffic actually at it.
  aircraft.sort((x, y) => x.dist - y.dist);

  res.setHeader("Cache-Control", `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=600`);
  res.end(JSON.stringify({
    airport: { key, name: ap.name, lat: ap.lat, lon: ap.lon, dist: ap.dist },
    fetched: Math.floor(Date.now() / 1000),
    source: "adsb.lol",
    aircraft: aircraft.slice(0, MAX_AIRCRAFT)
  }));
};
