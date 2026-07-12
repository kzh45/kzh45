// Tests for orderStationsByPrecedence — the topological merge that turns every scheduled
// trip's stop sequence into one line-ordered station list. This is the algorithm behind
// GET /api/routes/:id/stations; it has to place branch stations after their junction and
// stay stable across the messy mix of full-run, short-turn, and skip-stop patterns MTA
// publishes.
//
// Run: npm test

const test = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../gtfs-static');

const { orderStationsByPrecedence } = _internal;

// Sequences are N/S-suffixed stop IDs (as in stop_times); ordering returns base IDs.
const S = (...ids) => ids.map((id) => `${id}S`);
const N = (...ids) => ids.map((id) => `${id}N`);

test('simple linear route: S-direction order preserved', () => {
  const order = orderStationsByPrecedence([S('A', 'B', 'C', 'D')]);
  assert.deepEqual(order, ['A', 'B', 'C', 'D']);
});

test('longest sequence defines the trunk order; short-turns slot in', () => {
  const order = orderStationsByPrecedence([
    S('A', 'B', 'C', 'D', 'E'), // full run
    S('C', 'D', 'E'), // short-turn starting mid-line
  ]);
  assert.deepEqual(order, ['A', 'B', 'C', 'D', 'E']);
});

test('branching route: shared trunk then both branches after the junction', () => {
  // Trunk A-B-J (junction), then branch 1 (J-X-Y) and branch 2 (J-P-Q) — the A train
  // shape: Lefferts and Far Rockaway both hang off Rockaway Blvd.
  const order = orderStationsByPrecedence([
    S('A', 'B', 'J', 'X', 'Y'),
    S('A', 'B', 'J', 'P', 'Q'),
  ]);
  // Trunk comes first, in order, and the junction precedes every branch station.
  assert.deepEqual(order.slice(0, 3), ['A', 'B', 'J']);
  const idx = (id) => order.indexOf(id);
  for (const branchStop of ['X', 'Y', 'P', 'Q']) assert.ok(idx('J') < idx(branchStop), `J before ${branchStop}`);
  assert.ok(idx('X') < idx('Y')); // within-branch order kept
  assert.ok(idx('P') < idx('Q'));
  assert.equal(order.length, 7); // all stations present, none duplicated
});

test('skip-stop pattern does not reorder the trunk', () => {
  const order = orderStationsByPrecedence([
    S('A', 'B', 'C', 'D', 'E'),
    S('A', 'C', 'E'), // express skipping B and D
  ]);
  assert.deepEqual(order, ['A', 'B', 'C', 'D', 'E']);
});

test('only N-direction data available: reversed into S-order', () => {
  // A route that only reported northbound trips — N goes south->north, so reversing it
  // recovers the S-direction (north->south) canonical order.
  const order = orderStationsByPrecedence([N('D', 'C', 'B', 'A')]);
  assert.deepEqual(order, ['A', 'B', 'C', 'D']);
});

test('contradictory orderings still return every station (no drop on cycle)', () => {
  // Two patterns disagree on B vs C order — a cycle. Must not silently drop a station.
  const order = orderStationsByPrecedence([S('A', 'B', 'C'), S('A', 'C', 'B')]);
  assert.equal(new Set(order).size, 3);
  assert.deepEqual([...order].sort(), ['A', 'B', 'C']);
});

test('empty input returns empty', () => {
  assert.deepEqual(orderStationsByPrecedence([]), []);
  assert.deepEqual(orderStationsByPrecedence([[]]), []);
});
