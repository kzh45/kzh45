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
