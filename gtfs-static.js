const fs = require('fs');
const path = require('path');
const readline = require('readline');
const AdmZip = require('adm-zip');
const fetch = require('node-fetch');
// Shared client/server geometry helpers (map-core exports them for node when require()d).
const { distanceMeters, bearingBetween, offsetRightOfTravel } = require('./public/map-core');

const STATIC_GTFS_URL = 'http://web.mta.info/developers/data/nyct/subway/google_transit.zip';
const DATA_DIR = path.join(__dirname, 'data', 'gtfs-static');
const ZIP_PATH = path.join(__dirname, 'data', 'gtfs_subway.zip');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // re-download weekly; MTA republishes roughly monthly

// A real-time NYCT trip_id (e.g. "014000_7..S") embeds the same "<originTime>_<route>..<dir>"
// substring found inside the corresponding static trip_id (e.g. "L0S1-7-1064-S300_014000_7..S97R").
// That substring is the key we use to match real-time trips to their scheduled counterpart.
// Most routes use two dots before the direction letter, but the shuttles (GS, FS, H) use one
// (e.g. "GS.S04R") — accept either.
const TRIP_KEY_RE = /(\d{6}_[^.]+\.{1,2}[NS])/;

// For express/diamond variants (7X, 6X, ...), the static schedule's trip_id embeds the base
// route letter ("...7..N27R") even though its route_id column says "7X", while the real-time
// trip_id keeps the "X" ("103200_7X..N"). Strip a trailing X so both sides key the same way —
// safe because the caller has already filtered to one specific routeId's own static trips.
function normalizeTripKey(key) {
  return key.replace(/X(\.{1,2}[NS])$/, '$1');
}

const loadedByRoute = new Map(); // routeId -> { data: loaded schedule, loadedAtMs }
const loadingPromiseByRoute = new Map(); // routeId -> in-flight load promise

let ensureStaticDataPromise = null;

// Multiple routes can call this concurrently (e.g. /api/lines loading 10 routes on a cold
// cache) — without a single-flight guard here, each would race to download the same zip
// and rm+extract the same directory at once, risking a corrupted DATA_DIR.
async function ensureStaticData() {
  const isFresh = fs.existsSync(DATA_DIR) && Date.now() - fs.statSync(DATA_DIR).mtimeMs < MAX_AGE_MS;
  if (isFresh) return;

  if (!ensureStaticDataPromise) {
    ensureStaticDataPromise = (async () => {
      fs.mkdirSync(path.dirname(ZIP_PATH), { recursive: true });
      const response = await fetch(STATIC_GTFS_URL);
      if (!response.ok) {
        throw new Error(`Static GTFS download failed: ${response.status} ${response.statusText}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(ZIP_PATH, buffer);

      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      new AdmZip(ZIP_PATH).extractAllTo(DATA_DIR, true);
      fs.utimesSync(DATA_DIR, new Date(), new Date());
    })().finally(() => {
      ensureStaticDataPromise = null;
    });
  }

  return ensureStaticDataPromise;
}

function parseCalendar() {
  const rows = fs
    .readFileSync(path.join(DATA_DIR, 'calendar.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);

  const services = rows.map((line) => {
    const [serviceId, mon, tue, wed, thu, fri, sat, sun] = line.split(',');
    return { serviceId, activeOnDay: [sun, mon, tue, wed, thu, fri, sat].map((v) => v === '1') };
  });

  const exceptions = new Map(); // "serviceId|YYYYMMDD" -> 1 (added) | 2 (removed)
  const exceptionRows = fs
    .readFileSync(path.join(DATA_DIR, 'calendar_dates.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);
  for (const line of exceptionRows) {
    const [serviceId, date, exceptionType] = line.split(',');
    exceptions.set(`${serviceId}|${date}`, Number(exceptionType));
  }

  return function serviceIdsForDate(date) {
    const yyyymmdd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
      date.getDate()
    ).padStart(2, '0')}`;
    const dayOfWeek = date.getDay();

    return services
      .filter((s) => {
        const exception = exceptions.get(`${s.serviceId}|${yyyymmdd}`);
        if (exception === 1) return true;
        if (exception === 2) return false;
        return s.activeOnDay[dayOfWeek];
      })
      .map((s) => s.serviceId);
  };
}

function parseTripsForRoute(routeId) {
  const rows = fs
    .readFileSync(path.join(DATA_DIR, 'trips.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);

  const tripsByKey = new Map(); // "code_route..dir" -> [{ tripId, serviceId }]
  const tripsByRouteDir = new Map(); // "route..dir" -> [{ code, tripId, serviceId }], sorted by code
  const headsignByTrip = new Map(); // tripId -> trip_headsign (destination, e.g. "Flushing-Main St")
  const tripIds = new Set();

  for (const line of rows) {
    const [tripRouteId, tripId, serviceId, headsign] = line.split(',');
    if (tripRouteId !== routeId) continue;

    const match = tripId.match(TRIP_KEY_RE);
    if (!match) continue;
    const key = normalizeTripKey(match[1]);

    const codeMatch = key.match(/^(\d{6})_(.+)$/);
    if (!codeMatch) continue;
    const code = Number(codeMatch[1]);
    const routeDir = codeMatch[2];

    if (!tripsByKey.has(key)) tripsByKey.set(key, []);
    tripsByKey.get(key).push({ tripId, serviceId });

    if (!tripsByRouteDir.has(routeDir)) tripsByRouteDir.set(routeDir, []);
    tripsByRouteDir.get(routeDir).push({ code, tripId, serviceId });

    if (headsign) headsignByTrip.set(tripId, headsign);
    tripIds.add(tripId);
  }

  for (const list of tripsByRouteDir.values()) list.sort((a, b) => a.code - b.code);

  return { tripsByKey, tripsByRouteDir, headsignByTrip, tripIds };
}

function timeStringToSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

async function parseStopTimesForTrips(tripIds) {
  const stopTimesByTrip = new Map(); // tripId -> Map(stopId -> scheduledSeconds)
  const rawSequenceByTrip = new Map(); // tripId -> [{ stopId, sequence }]

  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(DATA_DIR, 'stop_times.txt')),
    crlfDelay: Infinity,
  });

  let isFirstLine = true;
  for await (const line of rl) {
    if (isFirstLine) {
      isFirstLine = false;
      continue;
    }
    const commaIndex = line.indexOf(',');
    const tripId = line.slice(0, commaIndex);
    if (!tripIds.has(tripId)) continue;

    const [, stopId, arrivalTime, departureTime, stopSequence] = line.split(',');
    const seconds = timeStringToSeconds(departureTime || arrivalTime);

    if (!stopTimesByTrip.has(tripId)) stopTimesByTrip.set(tripId, new Map());
    stopTimesByTrip.get(tripId).set(stopId, seconds);

    if (!rawSequenceByTrip.has(tripId)) rawSequenceByTrip.set(tripId, []);
    rawSequenceByTrip.get(tripId).push({ stopId, sequence: Number(stopSequence) });
  }

  const stopSequenceByTrip = new Map(); // tripId -> [stopId, ...] ordered by stop_sequence
  for (const [tripId, entries] of rawSequenceByTrip) {
    entries.sort((a, b) => a.sequence - b.sequence);
    stopSequenceByTrip.set(tripId, entries.map((e) => e.stopId));
  }

  return { stopTimesByTrip, stopSequenceByTrip };
}

function parseStationsForRoute(stopTimesByTrip) {
  const baseStopIds = new Set();
  for (const stopTimes of stopTimesByTrip.values()) {
    for (const stopId of stopTimes.keys()) {
      baseStopIds.add(stopId.slice(0, -1)); // strip trailing N/S platform suffix
    }
  }

  const rows = fs
    .readFileSync(path.join(DATA_DIR, 'stops.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);

  const stations = new Map(); // stopId -> { name, lat, lon }
  for (const line of rows) {
    const [stopId, stopName, lat, lon, locationType] = line.split(',');
    if (locationType !== '1' || !baseStopIds.has(stopId)) continue;
    stations.set(stopId, { name: stopName, lat: Number(lat), lon: Number(lon) });
  }

  return stations;
}

function parseShapeIdsForRoute(routeId) {
  const rows = fs
    .readFileSync(path.join(DATA_DIR, 'trips.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);

  const shapeIdsByDirection = { 0: new Set(), 1: new Set() }; // direction_id -> shape_ids
  for (const line of rows) {
    const [tripRouteId, , , , directionId, shapeId] = line.split(',');
    if (tripRouteId !== routeId) continue;
    shapeIdsByDirection[directionId]?.add(shapeId);
  }
  return shapeIdsByDirection;
}

// distanceMeters comes from map-core (top of file) — this file had its own identical
// copy for years; one implementation now serves shape dedup, complex merging, and strands.

// Evenly-spaced sample points along a shape's length, used as a cheap "fingerprint" to
// tell genuinely different branches apart from near-duplicate shape variants (e.g. the
// same physical path with a slightly different terminal turnback).
function sampleShape(points, sampleCount) {
  const samples = [points[0]];
  for (let i = 1; i < sampleCount; i++) {
    const idx = Math.round((i / (sampleCount - 1)) * (points.length - 1));
    samples.push(points[idx]);
  }
  return samples;
}

const SHAPE_DEDUP_SAMPLE_COUNT = 8;
const SHAPE_DEDUP_TOLERANCE_METERS = 300;

function shapesAreSimilar(sampleA, sampleB) {
  for (let i = 0; i < sampleA.length; i++) {
    if (distanceMeters(sampleA[i], sampleB[i]) > SHAPE_DEDUP_TOLERANCE_METERS) return false;
  }
  return true;
}

async function parseShapesForRoute(routeId) {
  const shapeIdsByDirection = parseShapeIdsForRoute(routeId);
  const candidateShapeIds = new Set([...shapeIdsByDirection[0], ...shapeIdsByDirection[1]]);

  const pointsByShapeId = new Map(); // shapeId -> [[lat, lon], ...]
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(DATA_DIR, 'shapes.txt')),
    crlfDelay: Infinity,
  });

  let isFirstLine = true;
  for await (const line of rl) {
    if (isFirstLine) {
      isFirstLine = false;
      continue;
    }
    const [shapeId, , lat, lon] = line.split(',');
    if (!candidateShapeIds.has(shapeId)) continue;
    if (!pointsByShapeId.has(shapeId)) pointsByShapeId.set(shapeId, []);
    pointsByShapeId.get(shapeId).push([Number(lat), Number(lon)]);
  }

  // Branching lines have several genuinely distinct physical paths per direction (e.g.
  // the A splitting to Lefferts/Far Rockaway, or N/Q/R/W's different Manhattan
  // crossings) — picking just one to draw left every station on the other branches
  // stranded kilometers from the drawn line. Keep one representative per *distinct*
  // path instead: cluster near-duplicate shape variants (same physical path, minor
  // differences like a terminal turnback) and keep the most detailed one from each.
  const shapeByDirection = {};
  for (const directionId of [0, 1]) {
    const shapes = [...shapeIdsByDirection[directionId]]
      .map((shapeId) => pointsByShapeId.get(shapeId))
      .filter((points) => points && points.length >= 2)
      .map((points) => ({ points, sample: sampleShape(points, SHAPE_DEDUP_SAMPLE_COUNT) }));

    const clusters = []; // [{ representative, sample }]
    for (const shape of shapes) {
      const cluster = clusters.find((c) => shapesAreSimilar(c.sample, shape.sample));
      if (!cluster) {
        clusters.push({ representative: shape.points, sample: shape.sample });
      } else if (shape.points.length > cluster.representative.length) {
        cluster.representative = shape.points;
      }
    }

    shapeByDirection[directionId] = clusters.map((c) => c.representative);
  }

  return shapeByDirection;
}

// The GTFS feed's own routes.txt route_color values are MTA's internal palette, which is
// slightly muted compared to the vivid colors actually used on subway signage/maps and
// universally recognized (Citymapper, Google Maps, MTA's own public map all use this set).
// Keyed by trunk letter — express variants (6X, 7X) share their base route's color.
const CANONICAL_ROUTE_COLORS = {
  1: '#EE352E', 2: '#EE352E', 3: '#EE352E',
  4: '#00933C', 5: '#00933C', 6: '#00933C',
  7: '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6',
  B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  G: '#6CBE45',
  J: '#996633', Z: '#996633',
  L: '#A7A9AC',
  N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  GS: '#808183', FS: '#808183', H: '#808183',
  SI: '#00A1DE',
};

function parseRouteColor(routeId) {
  const trunkId = routeId.replace(/X$/, ''); // 6X/7X share their base route's color
  if (CANONICAL_ROUTE_COLORS[trunkId]) return CANONICAL_ROUTE_COLORS[trunkId];

  const rows = fs
    .readFileSync(path.join(DATA_DIR, 'routes.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(1);

  for (const line of rows) {
    const fields = line.split(',');
    if (fields[0] === routeId) {
      const color = fields[fields.length - 3]; // route_color, 3rd-from-last column
      return color ? `#${color}` : null;
    }
  }
  return null;
}

async function load(routeId) {
  await ensureStaticData();
  const serviceIdsForDate = parseCalendar();
  const { tripsByKey, tripsByRouteDir, headsignByTrip, tripIds } = parseTripsForRoute(routeId);
  const { stopTimesByTrip, stopSequenceByTrip } = await parseStopTimesForTrips(tripIds);
  const stations = parseStationsForRoute(stopTimesByTrip);
  const shapeByDirection = await parseShapesForRoute(routeId);
  const color = parseRouteColor(routeId);
  return {
    serviceIdsForDate, tripsByKey, tripsByRouteDir, headsignByTrip, stopTimesByTrip, stopSequenceByTrip, stations, shapeByDirection, color,
  };
}

const refreshingRoutes = new Set(); // routes with a background re-parse in flight

async function getLoaded(routeId) {
  const entry = loadedByRoute.get(routeId);
  if (entry) {
    // Without this, a long-running server would keep serving whatever schedule it parsed
    // at startup forever — load() (and the weekly zip re-download inside ensureStaticData)
    // is only reached on a cache miss, and entries were never invalidated. Refresh
    // stale-while-revalidate style: keep serving the old parse (schedules drift slowly,
    // ~monthly republish) rather than stalling live requests on the ~7s re-parse.
    if (Date.now() - entry.loadedAtMs > MAX_AGE_MS && !refreshingRoutes.has(routeId)) {
      refreshingRoutes.add(routeId);
      load(routeId)
        .then((data) => loadedByRoute.set(routeId, { data, loadedAtMs: Date.now() }))
        .catch((err) => console.error(`Background schedule refresh failed for ${routeId}:`, err.message))
        .finally(() => refreshingRoutes.delete(routeId));
    }
    return entry.data;
  }

  if (!loadingPromiseByRoute.has(routeId)) {
    loadingPromiseByRoute.set(
      routeId,
      load(routeId).catch((err) => {
        loadingPromiseByRoute.delete(routeId); // allow a retry on the next call instead of caching the failure
        throw err;
      })
    );
  }

  const data = await loadingPromiseByRoute.get(routeId);
  loadedByRoute.set(routeId, { data, loadedAtMs: Date.now() });
  return data;
}

// Real-time trips don't always land on an exact scheduled origin-time code (real-world
// dispatching drifts from the timetable) — this is common on busier/more complex lines.
// A trip within this many code units (minutes*100, so 800 = 8 minutes) of the target is
// still considered a match, picking the closest one.
const FALLBACK_CODE_TOLERANCE = 800;

// Anchors a GTFS stop time (seconds past a service day's midnight, may exceed 24:00:00)
// to a concrete epoch, considering every service day the trip's service actually runs on
// among the reference time's yesterday/today/tomorrow, and picking the one landing
// nearest the REFERENCE time (the real-time predicted time when available, else now).
// Getting the day wrong is a ±24h delay error, and both directions occurred in the wild:
// - Late-night trips (times like 25:10 under YESTERDAY's service) anchored to today read
//   24h early, so delayed overnight trains always showed "on-time".
// - Trips pre-assigned in the feed for TOMORROW's service (visible from mid-afternoon
//   onward) anchored to today showed as phantom "+24h delayed" red trains every evening.
//   Only the predicted time disambiguates these: to wall-clock "now", tonight's 8:55pm
//   anchor always looks closer than tomorrow's.
function anchorScheduledMs(serviceIdsForDate, serviceId, scheduledSeconds, referenceMs) {
  const refMs = referenceMs instanceof Date ? referenceMs.getTime() : referenceMs;
  const refDayStart = new Date(refMs);
  refDayStart.setHours(0, 0, 0, 0);

  let best = null;
  for (const dayOffset of [-1, 0, 1]) {
    const dayStart = new Date(refDayStart);
    dayStart.setDate(dayStart.getDate() + dayOffset);
    if (!serviceIdsForDate(dayStart).includes(serviceId)) continue;
    const anchored = dayStart.getTime() + scheduledSeconds * 1000;
    if (best === null || Math.abs(anchored - refMs) < Math.abs(best - refMs)) best = anchored;
  }
  return best;
}

// Finds the static trip match for a real-time trip at a given stop, across services
// active on the reference day or its neighbors (feeds pre-assign next-service-day trips
// from mid-afternoon, and late-night trips belong to the previous service day). Exact
// origin-time-code matches are preferred; otherwise the nearest code within tolerance.
// Within a tier, the candidate whose anchored schedule time lands nearest the reference
// time wins. Returns { tripId, scheduledMs } for the given stop, or null.
function matchStaticTrip(schedule, realtimeTripId, stopId, referenceMs) {
  const { serviceIdsForDate, tripsByKey, tripsByRouteDir, stopTimesByTrip } = schedule;

  const match = realtimeTripId.match(TRIP_KEY_RE);
  if (!match) return null;
  const key = normalizeTripKey(match[1]);
  const refMs = referenceMs instanceof Date ? referenceMs.getTime() : referenceMs;

  const evaluate = (candidate) => {
    const stopTimes = stopTimesByTrip.get(candidate.tripId);
    if (!stopTimes || !stopTimes.has(stopId)) return null;
    const scheduledMs = anchorScheduledMs(serviceIdsForDate, candidate.serviceId, stopTimes.get(stopId), refMs);
    return scheduledMs === null ? null : { tripId: candidate.tripId, scheduledMs };
  };

  const pickNearestReference = (candidates) => {
    let best = null;
    for (const candidate of candidates) {
      const result = evaluate(candidate);
      if (result && (!best || Math.abs(result.scheduledMs - refMs) < Math.abs(best.scheduledMs - refMs))) {
        best = result;
      }
    }
    return best;
  };

  // Trust an exact-code match only when its anchored time is plausibly near the
  // reference. An exact code can exist ONLY under the wrong day's service (e.g. today's
  // 8:48am code is Saturday-only while tomorrow's Sunday equivalent is 8:49) — blindly
  // short-circuiting on it produced ±24h matches while a near-code candidate sat minutes
  // away in the fallback tier. Real delays beyond this window are effectively suspended
  // service, where "unknown" is more honest than a day-crossed guess anyway.
  const EXACT_TRUST_MS = 2 * 3600 * 1000;
  const exact = pickNearestReference(tripsByKey.get(key) || []);
  if (exact && Math.abs(exact.scheduledMs - refMs) <= EXACT_TRUST_MS) return exact;

  const codeMatch = key.match(/^(\d{6})_(.+)$/);
  if (!codeMatch) return exact;
  const targetCode = Number(codeMatch[1]);
  const routeDir = codeMatch[2];

  // Superset of the exact-key trips (code diff 0), so the exact match still wins here
  // whenever it genuinely is the nearest.
  const withinTolerance = (tripsByRouteDir.get(routeDir) || []).filter(
    (c) => Math.abs(c.code - targetCode) <= FALLBACK_CODE_TOLERANCE
  );
  return pickNearestReference(withinTolerance) || exact;
}

// Returns the scheduled epoch-ms for a real-time trip at a given stop, or null if no
// matching scheduled trip/stop is found (e.g. an unscheduled/extra train, or a brand-new
// static schedule not yet reflecting a recent service change). Pass the trip's PREDICTED
// time at this stop as `reference` when available — it's what disambiguates which service
// day a trip belongs to (see anchorScheduledMs).
async function getScheduledTimeMs(routeId, realtimeTripId, stopId, reference = new Date()) {
  let schedule;
  try {
    schedule = await getLoaded(routeId);
  } catch (err) {
    console.error('Static GTFS schedule unavailable:', err.message);
    return null;
  }

  const match = matchStaticTrip(schedule, realtimeTripId, stopId, reference);
  return match ? match.scheduledMs : null;
}

// Returns the stop_id immediately before targetStopId in the real, scheduled stop sequence
// of the matching static trip — correct for branching/skip-stop lines, unlike a hardcoded
// global station order. Returns null if there's no match or targetStopId is the first stop.
async function getAdjacentStopId(routeId, realtimeTripId, targetStopId, now = new Date()) {
  let schedule;
  try {
    schedule = await getLoaded(routeId);
  } catch (err) {
    console.error('Static GTFS schedule unavailable:', err.message);
    return null;
  }

  const match = matchStaticTrip(schedule, realtimeTripId, targetStopId, now);
  if (!match) return null;

  const sequence = schedule.stopSequenceByTrip.get(match.tripId);
  if (!sequence) return null;

  const idx = sequence.indexOf(targetStopId);
  return idx > 0 ? sequence[idx - 1] : null;
}

// Returns the matched static trip's headsign (destination, e.g. "Flushing-Main St"),
// or null when the trip has no schedule match.
async function getTripHeadsign(routeId, realtimeTripId, stopId, now = new Date()) {
  let schedule;
  try {
    schedule = await getLoaded(routeId);
  } catch (err) {
    console.error('Static GTFS schedule unavailable:', err.message);
    return null;
  }

  const match = matchStaticTrip(schedule, realtimeTripId, stopId, now);
  return (match && schedule.headsignByTrip.get(match.tripId)) || null;
}

// direction_id 1 corresponds to the "S" (Manhattan-bound) platform suffix, 0 to "N".
const DIRECTION_ID_TO_LETTER = { 0: 'N', 1: 'S' };

// Orders the base stop IDs a route serves into line order (S-direction start -> end) by
// topologically merging every scheduled trip's stop sequence. No single trip covers a
// branching line (the A's Lefferts and Far Rockaway branches are different trips), so
// consecutive-stop pairs from ALL trips form a precedence graph instead; branch stations
// come out after their junction. Kahn's algorithm with a preference for the order stops
// first appear keeps the main trunk reading naturally. Pure — takes N/S-suffixed stop
// sequences, returns ordered base stop IDs.
function orderStationsByPrecedence(stopSequences) {
  const preferredOrder = new Map(); // base stopId -> first-seen index, for stable tie-breaks
  const successors = new Map(); // base stopId -> Set(next base stopId)
  const indegree = new Map();

  const addNode = (id) => {
    if (!preferredOrder.has(id)) preferredOrder.set(id, preferredOrder.size);
    if (!indegree.has(id)) indegree.set(id, 0);
    if (!successors.has(id)) successors.set(id, new Set());
  };

  // Iterate longest sequences first so the trunk defines the preferred ordering.
  const southbound = stopSequences.filter((seq) => seq.length && seq[0].slice(-1) === 'S').sort((a, b) => b.length - a.length);
  // Some services (rare patterns) may only have N-direction data — use it reversed.
  const usable = southbound.length
    ? southbound
    : stopSequences
        .filter((seq) => seq.length)
        .sort((a, b) => b.length - a.length)
        .map((seq) => [...seq].reverse());

  for (const seq of usable) {
    const bases = seq.map((s) => s.slice(0, -1));
    for (const id of bases) addNode(id);
    for (let i = 1; i < bases.length; i++) {
      const [a, b] = [bases[i - 1], bases[i]];
      if (a !== b && !successors.get(a).has(b)) {
        successors.get(a).add(b);
        indegree.set(b, indegree.get(b) + 1);
      }
    }
  }

  const ready = [...indegree.keys()].filter((id) => indegree.get(id) === 0);
  const ordered = [];
  while (ready.length) {
    ready.sort((a, b) => preferredOrder.get(a) - preferredOrder.get(b));
    const id = ready.shift();
    ordered.push(id);
    for (const next of successors.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  // Contradictory orderings across service patterns would leave a cycle — append
  // whatever remains in first-seen order rather than dropping stations.
  for (const id of preferredOrder.keys()) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

async function getRouteStations(routeId) {
  const { stopSequenceByTrip, stations } = await getLoaded(routeId);
  const ordered = orderStationsByPrecedence([...stopSequenceByTrip.values()]);

  return {
    routeId,
    stations: ordered
      .filter((id) => stations.has(id))
      .map((id) => ({ stopId: id, name: stations.get(id).name })),
  };
}

// Returns { stations: [{ stopId, name, lat, lon }], track: { N: [[[lat,lon],...],...], S: [...] }, color }
// track.N/S are arrays of polylines (one per distinct physical branch), not a single line.
async function getGeometry(routeId) {
  const { stations, shapeByDirection, color } = await getLoaded(routeId);

  return {
    routeId,
    color,
    stations: [...stations.entries()].map(([stopId, s]) => ({ stopId, ...s })),
    track: {
      N: shapeByDirection[0],
      S: shapeByDirection[1],
    },
  };
}

// One physical station complex often appears as several GTFS parent stations — Times
// Sq-42 St is FOUR (127/725/902/R16, one per operating division), Grand Central three,
// Fulton St four. Drawn naively that's several dots and labels stacked on one corner.
// transfers.txt says which parents are connected; union the ones that are also visually
// the same place: same name within 250m, or any name within 150m. The distance guard
// keeps officially-linked-but-distinct stations apart (Port Authority vs Times Sq at
// 330m+, the 6th-Av vs 7th-Av 14 Sts at 339m) while collapsing true complexes.
function assignComplexIds(stationsById) {
  const parent = new Map([...stationsById.keys()].map((id) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };

  let rows;
  try {
    rows = fs.readFileSync(path.join(DATA_DIR, 'transfers.txt'), 'utf8').trim().split('\n').slice(1);
  } catch {
    return parent; // no transfers data — every station is its own complex
  }

  for (const line of rows) {
    const [from, to] = line.split(',');
    if (from === to) continue;
    const a = stationsById.get(from);
    const b = stationsById.get(to);
    if (!a || !b) continue;
    const d = distanceMeters([a.lat, a.lon], [b.lat, b.lon]);
    if (d < 150 || (a.name === b.name && d < 250)) parent.set(find(from), find(to));
  }

  const complexById = new Map();
  for (const id of stationsById.keys()) complexById.set(id, find(id));
  return complexById;
}

// Draw order for parallel strands. Where several routes share physical track, each is
// nudged perpendicular by a slot so they render side-by-side instead of one color hiding
// the rest — the way MTA's own map draws the Broadway or Lexington trunks. This order
// decides which line takes which side; grouping trunk-mates adjacently keeps each bundle
// tight and stops strands from crossing. Any route not listed sorts to the end.
const STRAND_RANK = new Map(
  [
    '1', '2', '3', '4', '5', '6', '6X', '7', '7X',
    'A', 'C', 'E', 'B', 'D', 'F', 'FX', 'M',
    'N', 'Q', 'R', 'W', 'G', 'J', 'Z', 'L',
    'GS', 'FS', 'H', 'SI',
  ].map((id, i) => [id, i])
);
const STRAND_SPACING_M = 22; // perpendicular gap between adjacent strands
const STRAND_CELL_DEG = 0.00025; // ~28m spatial-hash cell for finding shared track
const STRAND_PARALLEL_DOT = 0.9; // |cos| of heading angle: only near-parallel lines bundle
// Routes bundle only if their shapes actually coincide within this. MTA reuses identical
// shape points on genuinely-shared track (measured median gap 0m), while separate
// structures that merely pass close underground — IRT vs BMT at the Atlantic/Barclays and
// DeKalb junctions — stay ~27m apart. 8m keeps the former together and the latter apart.
const STRAND_MERGE_DIST_M = 8;
const STRAND_SMOOTH_M = 250; // along-track median window that absorbs transient junction spikes
// Inline meters-per-degree for the bundle-detection hot loop ONLY (runs ~92k points ×
// neighbor entries; map-core's distanceMeters would allocate + recompute cos per call).
// Everything non-hot uses the shared map-core helpers.
const EARTH_M_PER_DEG = 111320;

function strandRank(routeId) {
  const r = STRAND_RANK.get(routeId);
  return r === undefined ? STRAND_RANK.size : r;
}

// routeId -> { N: [offsetPolyline,...], S: [...] } for DRAWING only. Station snapping and
// train interpolation keep using the true centerline (route.track) — trains run down the
// middle of their bundle, the colored strands fan out around them. Bundles are found by
// spatial hashing every route's shape points and grouping near-parallel neighbours; a
// point on solo track gets no offset, so single-route segments stay exactly where they are.
function computeParallelStrands(routes) {
  const cosLat = (lat) => Math.cos((lat * Math.PI) / 180);
  const cellKey = (lat, lon) => `${Math.round(lat / STRAND_CELL_DEG)},${Math.round(lon / STRAND_CELL_DEG)}`;
  const grid = new Map(); // cellKey -> [{ routeId, uE, uN }]
  const metas = []; // { routeId, direction, polyIdx, points, headings }

  for (const route of routes) {
    for (const direction of ['N', 'S']) {
      const polylines = route.track?.[direction] || [];
      polylines.forEach((raw, polyIdx) => {
        const points = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1]);
        if (points.length < 2) return;
        // Line ORIENTATION, not travel direction: canonicalize each unit heading into the
        // north (tie: east) half-plane. Without this, a route's northbound and southbound
        // shapes offset to OPPOSITE sides — trunk-mates' strands then stack and the
        // later-drawn route's color overpaints both (invisible on same-color trunks like
        // N/Q/R/W, but E's blue vanished under F's orange on Queens Blvd).
        const headings = points.map((_, i) => {
          const src = i < points.length - 1 ? points[i] : points[i - 1];
          const dst = i < points.length - 1 ? points[i + 1] : points[i];
          const b = bearingBetween(src, dst) || [1, 0]; // (east, north); null only for degenerate pairs
          return b[1] < 0 || (b[1] === 0 && b[0] < 0) ? [-b[0], -b[1]] : b;
        });
        points.forEach((p, i) => {
          const k = cellKey(p[0], p[1]);
          let arr = grid.get(k);
          if (!arr) grid.set(k, (arr = []));
          arr.push({ routeId: route.routeId, lat: p[0], lon: p[1], uE: headings[i][0], uN: headings[i][1] });
        });
        metas.push({ routeId: route.routeId, direction, polyIdx, points, headings });
      });
    }
  }

  const out = new Map();
  const ensure = (routeId) => {
    let o = out.get(routeId);
    if (!o) out.set(routeId, (o = { N: [], S: [] }));
    return o;
  };

  const routesWithOffsets = new Set();

  for (const meta of metas) {
    const { points, headings } = meta;

    // Raw signed offset per point = its slot within the local shared-track bundle.
    const raw = points.map((p, i) => {
      const [uE, uN] = headings[i];
      const ci = Math.round(p[0] / STRAND_CELL_DEG);
      const cj = Math.round(p[1] / STRAND_CELL_DEG);
      const bundle = new Set([meta.routeId]);
      const cLat = cosLat(p[0]);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const arr = grid.get(`${ci + di},${cj + dj}`);
          if (!arr) continue;
          for (const e of arr) {
            if (e.routeId === meta.routeId || bundle.has(e.routeId)) continue;
            if (Math.abs(e.uE * uE + e.uN * uN) < STRAND_PARALLEL_DOT) continue; // not parallel — a crossing line
            const dN = (e.lat - p[0]) * EARTH_M_PER_DEG;
            const dE = (e.lon - p[1]) * EARTH_M_PER_DEG * cLat;
            if (Math.hypot(dN, dE) <= STRAND_MERGE_DIST_M) bundle.add(e.routeId); // tracks actually coincide
          }
        }
      }
      if (bundle.size < 2) return 0;
      const ranked = [...bundle].sort((a, b) => strandRank(a) - strandRank(b));
      return (ranked.indexOf(meta.routeId) - (ranked.length - 1) / 2) * STRAND_SPACING_M;
    });

    // Median-smooth the offset along the line. Junctions (DeKalb, Canal…) briefly stack
    // many routes within merge distance, spiking one point's slot; a route's real trunk
    // membership is sustained over long runs, so the windowed median rejects those narrow
    // spikes and eases the transitions where a route joins or leaves a bundle.
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + distanceMeters(points[i - 1], points[i]);
    const smooth = raw.map((_, i) => {
      let lo = i;
      let hi = i;
      while (lo > 0 && cum[i] - cum[lo - 1] <= STRAND_SMOOTH_M) lo--;
      while (hi < points.length - 1 && cum[hi + 1] - cum[i] <= STRAND_SMOOTH_M) hi++;
      const win = raw.slice(lo, hi + 1).sort((a, b) => a - b);
      return win[Math.floor(win.length / 2)];
    });

    let anyOffset = false;
    const offsetPoly = points.map((p, i) => {
      const s = smooth[i];
      if (!s) return p;
      anyOffset = true;
      const [lat, lon] = offsetRightOfTravel(p, headings[i], s);
      // 6 decimals ≈ 0.1m — noise against a 22m offset. Full doubles would serialize at
      // 15+ digits and roughly triple this endpoint's JSON size.
      return [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6];
    });
    ensure(meta.routeId)[meta.direction][meta.polyIdx] = offsetPoly;
    if (anyOffset) routesWithOffsets.add(meta.routeId);
  }

  // Backfill polylines that were too short to offset, so display indices line up with track
  // and no sparse holes reach JSON.
  for (const route of routes) {
    const o = ensure(route.routeId);
    for (const direction of ['N', 'S']) {
      const src = route.track?.[direction] || [];
      for (let i = 0; i < src.length; i++) if (!o[direction][i]) o[direction][i] = src[i];
    }
  }

  // Only routes that actually got an offset somewhere need a display copy — for the rest
  // the client falls back to the true track (trackDisplay || track), keeping verbatim
  // duplicates of isolated lines (the L, Franklin shuttle) out of the payload entirely.
  for (const routeId of [...out.keys()]) {
    if (!routesWithOffsets.has(routeId)) out.delete(routeId);
  }
  return out;
}

// Returns geometry for multiple routes at once: stations deduped across routes (a
// physical station may be served by several lines), plus each route's own track/color.
async function getMultiRouteGeometry(routeIds) {
  const results = await Promise.all(routeIds.map((routeId) => getGeometry(routeId)));

  const stationsById = new Map();
  for (const r of results) {
    for (const s of r.stations) {
      if (!stationsById.has(s.stopId)) stationsById.set(s.stopId, s);
    }
  }

  const complexById = assignComplexIds(stationsById);
  const strands = computeParallelStrands(results);

  return {
    stations: [...stationsById.values()].map((s) => ({ ...s, complexId: complexById.get(s.stopId) })),
    // stationIds lets clients filter the global station list down to just the ~20-90
    // stations a given route actually serves before doing any per-station geometry
    // matching — without it, matching logic ends up checking every station against every
    // route's shapes (475 stations x 27 routes instead of ~50 x 27), which is the
    // difference between sub-100ms and a multi-second main-thread stall on page load.
    routes: results.map((r) => ({
      routeId: r.routeId,
      color: r.color,
      track: r.track, // true centerline — station snapping + train interpolation
      // Parallel-offset strands, drawing only; absent when this route shares no track
      // (clients fall back to the centerline via trackDisplay || track).
      trackDisplay: strands.get(r.routeId),
      stationIds: r.stations.map((s) => s.stopId),
    })),
  };
}

module.exports = {
  getScheduledTimeMs,
  getAdjacentStopId,
  getTripHeadsign,
  getGeometry,
  getMultiRouteGeometry,
  getRouteStations,
  parseRouteColor,
  DIRECTION_ID_TO_LETTER,
  // Pure internals exposed for tests only — the trip-ID quirk handling here (express-X
  // stripping, single-dot shuttles, nearest-code fallback) took real investigation to get
  // right and is the most regression-prone logic in the codebase.
  _internal: {
    TRIP_KEY_RE,
    normalizeTripKey,
    matchStaticTrip,
    anchorScheduledMs,
    orderStationsByPrecedence,
    computeParallelStrands,
    FALLBACK_CODE_TOLERANCE,
  },
};
