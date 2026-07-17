// Tests for the right-hand-running offset math in map-core.js — trains are drawn a few
// pixels to the RIGHT of their direction of travel so uptown/downtown trains separate
// onto opposite sides of the single drawn line. Getting the offset direction wrong would
// silently put opposing trains on the same side (the bug this feature fixes), so the
// geometry deserves a guard.
//
// Run: npm test

const test = require('node:test');
const assert = require('node:assert');
const { distanceMeters, bearingBetween, offsetRightOfTravel, pointAndBearingAtDistance } = require('../public/map-core');
const { _internal } = require('../gtfs-static');

const { computeParallelStrands } = _internal;

// NYC scale: ~111320 m per degree lat, ~84000 m per degree lon at 40.75N.
test('distanceMeters: 1 degree of latitude ~111km', () => {
  const d = distanceMeters([40, -74], [41, -74]);
  assert.ok(Math.abs(d - 111320) < 500, `got ${d}`);
});

test('bearingBetween: due north is unit vector (0, 1)', () => {
  const [ux, uy] = bearingBetween([40.7, -74], [40.8, -74]);
  assert.ok(Math.abs(ux) < 1e-9);
  assert.ok(Math.abs(uy - 1) < 1e-9);
});

test('bearingBetween: due east is unit vector (1, 0)', () => {
  const [ux, uy] = bearingBetween([40.75, -74.0], [40.75, -73.9]);
  assert.ok(Math.abs(ux - 1) < 1e-9);
  assert.ok(Math.abs(uy) < 1e-9);
});

test('offset right of NORTH travel moves EAST (higher longitude)', () => {
  // Northbound train (bearing 0,1). Right of north is east -> longitude increases.
  const [lat, lon] = offsetRightOfTravel([40.75, -73.98], [0, 1], 20);
  assert.ok(lon > -73.98, `expected lon east of start, got ${lon}`);
  assert.ok(Math.abs(lat - 40.75) < 1e-6, 'latitude essentially unchanged');
});

test('offset right of SOUTH travel moves WEST (lower longitude)', () => {
  // Southbound train (bearing 0,-1). Right of south is west -> longitude decreases.
  const [lat, lon] = offsetRightOfTravel([40.75, -73.98], [0, -1], 20);
  assert.ok(lon < -73.98, `expected lon west of start, got ${lon}`);
  assert.ok(Math.abs(lat - 40.75) < 1e-6);
});

test('opposing trains at the same point end up on opposite sides', () => {
  const point = [40.75, -73.98];
  const north = offsetRightOfTravel(point, [0, 1], 20); // east
  const south = offsetRightOfTravel(point, [0, -1], 20); // west
  assert.ok(north[1] > point[1] && south[1] < point[1], 'north east of south');
  // Roughly symmetric about the track.
  assert.ok(Math.abs(north[1] - point[1] - (point[1] - south[1])) < 1e-6);
});

test('offset magnitude matches requested meters', () => {
  const point = [40.75, -73.98];
  const moved = offsetRightOfTravel(point, [0, 1], 30);
  assert.ok(Math.abs(distanceMeters(point, moved) - 30) < 0.5);
});

test('zero offset or null bearing returns the point unchanged', () => {
  assert.deepEqual(offsetRightOfTravel([40.75, -73.98], [0, 1], 0), [40.75, -73.98]);
  assert.deepEqual(offsetRightOfTravel([40.75, -73.98], null, 20), [40.75, -73.98]);
});

// computeParallelStrands offsets shared-track routes onto side-by-side strands for
// drawing, without touching solo track or bundling routes that merely cross. Getting the
// bundling wrong would either wash lines out (no offset) or shove solo lines off the map.
const EARTH = 111320;
const sharedEW = () => [
  [40.75, -74.0],
  [40.75, -73.99],
  [40.75, -73.98],
];

test('two routes on the same track offset to opposite, centered sides ~22m apart', () => {
  const out = computeParallelStrands([
    { routeId: 'N', track: { N: [sharedEW()], S: [] } },
    { routeId: 'Q', track: { N: [sharedEW()], S: [] } },
  ]);
  const nLat = out.get('N').N[0][1][0];
  const qLat = out.get('Q').N[0][1][0];
  assert.ok(Math.sign(nLat - 40.75) !== Math.sign(qLat - 40.75), 'opposite sides of the track');
  assert.ok(Math.abs((nLat - 40.75) * EARTH - 11) < 0.5, `N ~11m off, got ${(nLat - 40.75) * EARTH}`);
  assert.ok(Math.abs(Math.abs(nLat - qLat) * EARTH - 22) < 0.5, 'strands ~22m apart');
});

test('a route alone on its track gets no display copy at all', () => {
  const out = computeParallelStrands([
    { routeId: 'N', track: { N: [sharedEW()], S: [] } },
    { routeId: '1', track: { N: [[[40.7, -74.0], [40.7, -73.99]]], S: [] } },
  ]);
  // Absent = client draws the true centerline; a verbatim copy would just bloat the payload.
  assert.equal(out.get('1'), undefined, 'solo route omitted from strand output');
});

test('a perpendicular crossing route does not bundle', () => {
  // An N-S line crossing the E-W track shares a grid cell but not a heading — neither
  // route shares track, so neither needs a display copy.
  const out = computeParallelStrands([
    { routeId: 'N', track: { N: [sharedEW()], S: [] } },
    { routeId: 'L', track: { N: [[[40.74, -73.99], [40.76, -73.99]]], S: [] } },
  ]);
  assert.equal(out.get('N'), undefined, 'N unchanged with only a crossing route nearby');
  assert.equal(out.get('L'), undefined);
});

test('both direction shapes of a route land on the SAME side (no mirroring)', () => {
  // Regression: headings must encode line orientation, not travel direction. If the
  // southbound shape (reversed point order) offsets to the opposite side, trunk-mates
  // stack their strands and the later-drawn color overpaints both.
  const reversed = () => [...sharedEW()].reverse();
  const out = computeParallelStrands([
    { routeId: 'N', track: { N: [sharedEW()], S: [reversed()] } },
    { routeId: 'Q', track: { N: [sharedEW()], S: [reversed()] } },
  ]);
  const sideOf = (poly) => Math.sign(poly[1][0] - 40.75); // midpoint lat vs centerline
  const nN = sideOf(out.get('N').N[0]);
  const nS = sideOf(out.get('N').S[0]);
  const qN = sideOf(out.get('Q').N[0]);
  const qS = sideOf(out.get('Q').S[0]);
  assert.ok(nN !== 0 && qN !== 0, 'both routes offset');
  assert.equal(nN, nS, "N route's two direction shapes on the same side");
  assert.equal(qN, qS, "Q route's two direction shapes on the same side");
  assert.notEqual(nN, qN, 'N and Q on opposite sides');
});

test('pointAndBearingAtDistance: midpoint of a straight E-W subpath', () => {
  // Two-point path due east; cumulative distance precomputed as the engine builds it.
  const points = [
    [40.75, -74.0],
    [40.75, -73.9],
  ];
  const total = distanceMeters(points[0], points[1]);
  const subPath = { points, cumDist: [0, total], total };
  const { point, bearing } = pointAndBearingAtDistance(subPath, total / 2);
  assert.ok(Math.abs(point[0] - 40.75) < 1e-9);
  assert.ok(Math.abs(point[1] - -73.95) < 1e-6, `midpoint lon ${point[1]}`);
  assert.ok(Math.abs(bearing[0] - 1) < 1e-9 && Math.abs(bearing[1]) < 1e-9);
});
