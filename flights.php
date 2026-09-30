<?php
/**
 * flights.php — Aeola "flight mode" proxy.
 *
 * Why this file has to exist: adsb.lol (like OpenSky and adsb.fi) sends no
 * Access-Control-Allow-Origin header, so a browser on your site can never call
 * it directly — only a server can. While we're here it also does the two other
 * jobs that would otherwise land in the browser:
 *
 *   1. Caching. One upstream call serves every visitor for CACHE_TTL seconds,
 *      so a busy page never hammers a free community API.
 *   2. Simplifying. Each aircraft is trimmed from ~30 ADS-B telemetry fields
 *      to the 10 Aeola actually uses, so the browser downloads a few hundred
 *      bytes instead of several KB.
 *
 * Airports are a fixed allowlist on purpose: accepting arbitrary lat/lon from
 * the query string would turn this into an open proxy that anyone could point
 * at adsb.lol on your server's behalf.
 *
 * Deploy: drop next to the Aeola HTML file. No configuration, no API key.
 * Data: adsb.lol, licensed ODbL 1.0 (credit: "Live traffic from adsb.lol (ODbL)").
 */

declare(strict_types=1);

const CACHE_TTL     = 120;  // seconds — matches the client's poll interval
const UPSTREAM_TMO  = 8;    // seconds
const MAX_AIRCRAFT  = 24;   // the client only shows 8; a small surplus covers filtering

// Cargo vs. passenger, from data already in the payload — see aeola_is_cargo()
// below for the full reasoning. Declared here, above the loop that uses it:
// unlike function declarations (hoisted), a top-level const only exists once
// the script has executed past this line — placing it after the loop that
// calls aeola_is_cargo() throws "Undefined constant" the moment any aircraft
// is processed.
const AEOLA_CARGO_PREFIXES = [
    'UPS', 'FDX', 'GTI', 'GEC', 'CLX', 'CLI', 'CKS', 'ABW', 'BOX', 'BCS',
    'CAO', 'SQC', 'MPH',
];

$AIRPORTS = [
    'essa' => ['name' => 'Stockholm Arlanda', 'lat' => 59.6519, 'lon' => 17.9186, 'dist' => 40],
    'eddk' => ['name' => 'Cologne Bonn',      'lat' => 50.8659, 'lon' =>  7.1427, 'dist' => 40],
];

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$key = strtolower(trim((string)($_GET['ap'] ?? 'essa')));
if (!isset($AIRPORTS[$key])) {
    http_response_code(400);
    echo json_encode(['error' => 'unknown airport', 'valid' => array_keys($AIRPORTS)]);
    exit;
}

$ap        = $AIRPORTS[$key];
$cacheFile = sys_get_temp_dir() . '/aeola_flights_' . $key . '.json';

// Fresh cache wins outright — no upstream call at all.
if (is_readable($cacheFile) && (time() - (int)filemtime($cacheFile)) < CACHE_TTL) {
    header('X-Aeola-Cache: hit');
    readfile($cacheFile);
    exit;
}

$url = sprintf(
    'https://api.adsb.lol/v2/lat/%.4f/lon/%.4f/dist/%d',
    $ap['lat'], $ap['lon'], $ap['dist']
);
$raw = aeola_fetch($url);

// Upstream down or slow: a stale cache beats an empty sky.
if ($raw === null) {
    if (is_readable($cacheFile)) {
        header('X-Aeola-Cache: stale');
        readfile($cacheFile);
        exit;
    }
    http_response_code(502);
    echo json_encode(['error' => 'upstream unavailable']);
    exit;
}

$data = json_decode($raw, true);
if (!is_array($data)) {
    if (is_readable($cacheFile)) {
        header('X-Aeola-Cache: stale');
        readfile($cacheFile);
        exit;
    }
    http_response_code(502);
    echo json_encode(['error' => 'bad upstream payload']);
    exit;
}

$aircraft = [];
foreach (($data['ac'] ?? []) as $a) {
    if (!isset($a['lat'], $a['lon'])) {
        continue;
    }

    // alt_baro is a number when airborne but the literal string "ground"
    // when it isn't — the single most common way this data trips people up.
    $altRaw   = $a['alt_baro'] ?? 0;
    $onGround = ($altRaw === 'ground');
    $altFt    = $onGround ? 0.0 : (is_numeric($altRaw) ? (float)$altRaw : 0.0);
    $speed    = (float)($a['gs'] ?? 0);

    $hex  = (string)($a['hex'] ?? '');
    $call = trim((string)($a['flight'] ?? ''));

    $aircraft[] = [
        'id'    => $hex,
        'call'  => $call !== '' ? $call : strtoupper($hex),
        'lat'   => round((float)$a['lat'], 4),
        'lon'   => round((float)$a['lon'], 4),
        'alt'   => (int)round(max(0.0, $altFt)),
        'gs'    => round($speed, 1),
        'trk'   => round((float)($a['track'] ?? 0), 1),
        'rate'  => (int)round((float)($a['baro_rate'] ?? 0)),
        'type'  => (string)($a['t'] ?? ''),          // often missing — client falls back
        'gnd'   => $onGround || $speed < 30.0,
        'cargo' => aeola_is_cargo($call),
        'dist'  => aeola_distance_km((float)$a['lat'], (float)$a['lon'], $ap['lat'], $ap['lon']),
    ];
}

// Nearest first, so "zooming in on an airport" actually means the traffic at it.
// A plain closure, not an arrow function: arrow functions need PHP 7.4+, and
// this file otherwise only needs 7.0+ — no reason to force a version bump
// for one line.
usort($aircraft, static function (array $x, array $y): int {
    return $x['dist'] <=> $y['dist'];
});
$aircraft = array_slice($aircraft, 0, MAX_AIRCRAFT);

$payload = json_encode([
    'airport'  => [
        'key'  => $key,
        'name' => $ap['name'],
        'lat'  => $ap['lat'],
        'lon'  => $ap['lon'],
        'dist' => $ap['dist'],
    ],
    'fetched'  => time(),
    'source'   => 'adsb.lol',
    'aircraft' => $aircraft,
], JSON_UNESCAPED_UNICODE);

// Write via a temp file + rename so a concurrent request can never read a
// half-written cache.
$tmp = $cacheFile . '.' . getmypid() . '.tmp';
if (@file_put_contents($tmp, $payload) !== false) {
    @rename($tmp, $cacheFile);
} else {
    @unlink($tmp);
}

header('X-Aeola-Cache: miss');
echo $payload;

/**
 * Fetch a URL, returning null on any failure. Prefers cURL, falls back to
 * the stream wrapper so this works on hosts with either one available.
 */
function aeola_fetch(string $url): ?string
{
    $ua = 'Aeola/1.0 (ambient instrument; https://aeola.vercel.app)';

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => UPSTREAM_TMO,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_USERAGENT      => $ua,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 2,
        ]);
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        // No curl_close(): it's a no-op since PHP 8.0 and raises a deprecation
        // notice in 8.5+. On a host with display_errors on, that notice prints
        // straight into the response body and corrupts the JSON.
        return ($body !== false && $code === 200) ? (string)$body : null;
    }

    $ctx = stream_context_create(['http' => [
        'method'        => 'GET',
        'timeout'       => UPSTREAM_TMO,
        'header'        => "User-Agent: {$ua}\r\n",
        'ignore_errors' => true,
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    return $body === false ? null : (string)$body;
}

/**
 * Cargo vs. passenger, from data already in the payload — no second API
 * call. adsb.lol's "flight" field is the real ICAO callsign, and the first
 * three letters are the operator's ICAO code, which is publicly documented
 * and constant per airline regardless of aircraft type or route. A
 * passenger 767 and a freighter 767 are the same "t" value; the operator
 * code is the part that actually says which one this is.
 *
 * Verified against live traffic while building this: Leipzig/Halle (DHL's
 * European hub) currently shows BCS-prefixed flights on A306/B752 — both
 * classic freighter types — one of them logged twice, once cruising and
 * once on the ground, confirming it's a real aircraft, not a fluke.
 *
 * Not an exhaustive list of every cargo operator in the world — just the
 * major ones likely to actually show up near Arlanda or Cologne Bonn.
 * (AEOLA_CARGO_PREFIXES itself is declared near the top of the file,
 * above the loop that calls this function — see the comment there.)
 */
function aeola_is_cargo(string $callsign): bool
{
    $prefix = strtoupper(substr(trim($callsign), 0, 3));
    return in_array($prefix, AEOLA_CARGO_PREFIXES, true);
}

/** Rough great-circle distance in km — plenty accurate for sorting. */
function aeola_distance_km(float $lat1, float $lon1, float $lat2, float $lon2): float
{
    $r  = 6371.0;
    $dLat = deg2rad($lat2 - $lat1);
    $dLon = deg2rad($lon2 - $lon1);
    $a = sin($dLat / 2) ** 2
       + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLon / 2) ** 2;
    return round($r * 2 * atan2(sqrt($a), sqrt(1 - $a)), 1);
}
