// Smoke tests for the trip-ID matching quirks in gtfs-static.js — the logic that maps a
// real-time NYCT trip ID to its static-schedule counterpart. Every case here encodes a
// real format quirk found the hard way against live MTA data; if one of these breaks,
// delay/status silently degrades to 'unknown' for whole routes rather than erroring.
//
// Run: npm test (node --test)

const test = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../gtfs-static');

const { TRIP_KEY_RE, normalizeTripKey, matchStaticTrip, FALLBACK_CODE_TOLERANCE } = _internal;

function extractKey(tripId) {
  const m = tripId.match(TRIP_KEY_RE);
  return m ? normalizeTripKey(m[1]) : null;
}

test('key extraction: real-time numbered-line ID', () => {
  assert.equal(extractKey('014000_7..S'), '014000_7..S');
});

test('key extraction: static ID with prefix and suffix junk', () => {
  assert.equal(extractKey('L0S1-7-1064-S300_014000_7..S97R'), '014000_7..S');
});

test('key extraction: shuttles use a single dot (GS/FS/H), not double', () => {
  assert.equal(extractKey('142850_GS.S04R'), '142850_GS.S');
  assert.equal(extractKey('BSP26GEN-H043-Weekday-00_036400_H..N21R'), '036400_H..N');
  assert.equal(extractKey('052100_FS.N01R'), '052100_FS.N');
});

test('express variants (7X/6X) normalize to the base route letter', () => {
  // Real-time keeps the X ("103200_7X..N") but the static schedule embeds the base
  // letter ("...103200_7..N27R") even when its route_id column says 7X — both sides
  // must key identically or express trains never match.
  assert.equal(extractKey('103200_7X..N'), '103200_7..N');
  assert.equal(extractKey('110650_6X..S'), '110650_6..S');
  // A plain key must pass through untouched.
  assert.equal(normalizeTripKey('014000_7..S'), '014000_7..S');
});

// Builds the minimal schedule shape matchStaticTrip reads. Keys must be pre-normalized,
// mirroring what parseTripsForRoute does when indexing the static data.
function makeSchedule(trips) {
  const tripsByKey = new Map();
  const tripsByRouteDir = new Map();
  const stopTimesByTrip = new Map();

  for (const t of trips) {
    const key = normalizeTripKey(t.key);
    if (!tripsByKey.has(key)) tripsByKey.set(key, []);
    tripsByKey.get(key).push({ tripId: t.tripId, serviceId: t.serviceId });

    const [, code, routeDir] = key.match(/^(\d{6})_(.+)$/);
    if (!tripsByRouteDir.has(routeDir)) tripsByRouteDir.set(routeDir, []);
    tripsByRouteDir.get(routeDir).push({ code: Number(code), tripId: t.tripId, serviceId: t.serviceId });

    stopTimesByTrip.set(t.tripId, new Map(t.stops.map((s) => [s, 0])));
  }
  for (const list of tripsByRouteDir.values()) list.sort((a, b) => a.code - b.code);

  return {
    serviceIdsForDate: () => ['Weekday'],
    tripsByKey,
    tripsByRouteDir,
    stopTimesByTrip,
  };
}

const NOW = new Date();

test('exact match: active service, stop served', () => {
  const schedule = makeSchedule([
    { key: '014000_7..S', tripId: 'static-1', serviceId: 'Weekday', stops: ['701S', '702S'] },
  ]);
  assert.equal(matchStaticTrip(schedule, '014000_7..S', '701S', NOW), 'static-1');
});

test('express 7X real-time trip matches base-7 static trip', () => {
  const schedule = makeSchedule([
    { key: '103200_7..N', tripId: 'static-7x', serviceId: 'Weekday', stops: ['723N'] },
  ]);
  assert.equal(matchStaticTrip(schedule, '103200_7X..N', '723N', NOW), 'static-7x');
});

test('single-dot shuttle trip matches', () => {
  const schedule = makeSchedule([
    { key: '142850_GS.S', tripId: 'static-gs', serviceId: 'Weekday', stops: ['901S', '902S'] },
  ]);
  assert.equal(matchStaticTrip(schedule, '142850_GS.S04R', '901S', NOW), 'static-gs');
});

test('Z trains encode as J on both sides — matches without special-casing', () => {
  // Live Z trips from the JZ feed carry J-embedded IDs (e.g. 049100_J..S16R), and static
  // Z trips do too (L0S1-J-1056-S12_044000_J..S16R) — consistent, so plain matching works.
  const schedule = makeSchedule([
    { key: '049100_J..S', tripId: 'static-z', serviceId: 'Weekday', stops: ['M23S'] },
  ]);
  assert.equal(matchStaticTrip(schedule, '049100_J..S16R', 'M23S', NOW), 'static-z');
});

test('nearest-code fallback: matches within tolerance, picks the closest', () => {
  const schedule = makeSchedule([
    { key: '137750_2..N', tripId: 'static-near', serviceId: 'Weekday', stops: ['201N'] },
    { key: '139000_2..N', tripId: 'static-far', serviceId: 'Weekday', stops: ['201N'] },
  ]);
  // 137400 has no exact match; 137750 (diff 350) beats 139000 (diff 1600, also > tolerance).
  assert.equal(matchStaticTrip(schedule, '137400_2..N', '201N', NOW), 'static-near');
});

test('nearest-code fallback: rejects candidates beyond tolerance', () => {
  const schedule = makeSchedule([
    { key: '150000_2..N', tripId: 'static-toofar', serviceId: 'Weekday', stops: ['201N'] },
  ]);
  // diff = 12600 >> FALLBACK_CODE_TOLERANCE (800)
  assert.ok(FALLBACK_CODE_TOLERANCE < 12600);
  assert.equal(matchStaticTrip(schedule, '137400_2..N', '201N', NOW), null);
});

test('candidates on inactive service days are skipped', () => {
  const schedule = makeSchedule([
    { key: '014000_7..S', tripId: 'static-sunday', serviceId: 'Sunday', stops: ['701S'] },
  ]);
  // serviceIdsForDate only returns Weekday — the Sunday candidate must not match, even exactly.
  assert.equal(matchStaticTrip(schedule, '014000_7..S', '701S', NOW), null);
});

test('candidates that do not serve the target stop are skipped', () => {
  const schedule = makeSchedule([
    // Same origin-time code, two branch variants serving different stops (A-train pattern):
    { key: '054400_A..S', tripId: 'static-lefferts', serviceId: 'Weekday', stops: ['A65S'] },
    { key: '054400_A..S', tripId: 'static-rockaway', serviceId: 'Weekday', stops: ['H11S'] },
  ]);
  assert.equal(matchStaticTrip(schedule, '054400_A..S58R', 'H11S', NOW), 'static-rockaway');
  assert.equal(matchStaticTrip(schedule, '054400_A..S58R', 'A65S', NOW), 'static-lefferts');
  assert.equal(matchStaticTrip(schedule, '054400_A..S58R', 'X99S', NOW), null);
});

test('garbage trip IDs return null instead of throwing', () => {
  const schedule = makeSchedule([]);
  assert.equal(matchStaticTrip(schedule, 'not-a-trip-id', '701S', NOW), null);
  assert.equal(matchStaticTrip(schedule, '', '701S', NOW), null);
});
