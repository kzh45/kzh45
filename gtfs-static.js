const fs = require('fs');
const path = require('path');
const readline = require('readline');
const AdmZip = require('adm-zip');
const fetch = require('node-fetch');

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

function metersPerDegree(lat) {
  return { lat: 111320, lon: 111320 * Math.cos((lat * Math.PI) / 180) };
}

function distanceMeters([lat1, lon1], [lat2, lon2]) {
  const { lat: mLat, lon: mLon } = metersPerDegree((lat1 + lat2) / 2);
  const dy = (lat2 - lat1) * mLat;
  const dx = (lon2 - lon1) * mLon;
  return Math.sqrt(dx * dx + dy * dy);
}

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

// Finds the static trip that's both active today-or-yesterday and actually serves the given
// stop: first by exact origin-time/route/direction code, falling back to the nearest code
// within tolerance in the same route+direction if no exact match qualifies. Returns the
// matched static tripId, or null.
function matchStaticTrip(schedule, realtimeTripId, stopId, now) {
  const { serviceIdsForDate, tripsByKey, tripsByRouteDir, stopTimesByTrip } = schedule;

  const match = realtimeTripId.match(TRIP_KEY_RE);
  if (!match) return null;
  const key = normalizeTripKey(match[1]);

  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const activeServiceIds = new Set([...serviceIdsForDate(today), ...serviceIdsForDate(yesterday)]);

  const isValidCandidate = (candidate) => {
    if (!activeServiceIds.has(candidate.serviceId)) return false;
    const stopTimes = stopTimesByTrip.get(candidate.tripId);
    return Boolean(stopTimes && stopTimes.has(stopId));
  };

  for (const candidate of tripsByKey.get(key) || []) {
    if (isValidCandidate(candidate)) return candidate.tripId;
  }

  const codeMatch = key.match(/^(\d{6})_(.+)$/);
  if (!codeMatch) return null;
  const targetCode = Number(codeMatch[1]);
  const routeDir = codeMatch[2];

  let best = null;
  let bestDiff = Infinity;
  for (const candidate of tripsByRouteDir.get(routeDir) || []) {
    const diff = Math.abs(candidate.code - targetCode);
    if (diff > FALLBACK_CODE_TOLERANCE || diff >= bestDiff) continue;
    if (!isValidCandidate(candidate)) continue;
    best = candidate;
    bestDiff = diff;
  }

  return best ? best.tripId : null;
}

// Returns the scheduled epoch-ms for a real-time trip at a given stop, or null if no
// matching scheduled trip/stop is found (e.g. an unscheduled/extra train, or a brand-new
// static schedule not yet reflecting a recent service change).
async function getScheduledTimeMs(routeId, realtimeTripId, stopId, now = new Date()) {
  let schedule;
  try {
    schedule = await getLoaded(routeId);
  } catch (err) {
    console.error('Static GTFS schedule unavailable:', err.message);
    return null;
  }

  const tripId = matchStaticTrip(schedule, realtimeTripId, stopId, now);
  if (!tripId) return null;

  const scheduledSeconds = schedule.stopTimesByTrip.get(tripId).get(stopId);
  const serviceDayStart = new Date(now);
  serviceDayStart.setHours(0, 0, 0, 0);
  // GTFS times can exceed 24:00:00 for trips continuing past midnight on the same service day.
  return serviceDayStart.getTime() + scheduledSeconds * 1000;
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

  const tripId = matchStaticTrip(schedule, realtimeTripId, targetStopId, now);
  if (!tripId) return null;

  const sequence = schedule.stopSequenceByTrip.get(tripId);
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

  const tripId = matchStaticTrip(schedule, realtimeTripId, stopId, now);
  return (tripId && schedule.headsignByTrip.get(tripId)) || null;
}

// direction_id 1 corresponds to the "S" (Manhattan-bound) platform suffix, 0 to "N".
const DIRECTION_ID_TO_LETTER = { 0: 'N', 1: 'S' };

// Stations a route serves, in line order (S-direction start -> end), derived by
// topologically merging every scheduled trip's stop sequence. No single trip covers a
// branching line (the A's Lefferts and Far Rockaway branches are different trips), so
// consecutive-stop pairs from ALL trips form a precedence graph instead; branch stations
// come out after their junction. Kahn's algorithm with a preference for the order stops
// first appear keeps the main trunk reading naturally.
async function getRouteStations(routeId) {
  const { stopSequenceByTrip, stations } = await getLoaded(routeId);

  const preferredOrder = new Map(); // base stopId -> first-seen index, for stable tie-breaks
  const successors = new Map(); // base stopId -> Set(next base stopId)
  const indegree = new Map();

  const addNode = (id) => {
    if (!preferredOrder.has(id)) preferredOrder.set(id, preferredOrder.size);
    if (!indegree.has(id)) indegree.set(id, 0);
    if (!successors.has(id)) successors.set(id, new Set());
  };

  // Iterate longest sequences first so the trunk defines the preferred ordering.
  const sequences = [...stopSequenceByTrip.values()]
    .filter((seq) => seq.length && seq[0].slice(-1) === 'S')
    .sort((a, b) => b.length - a.length);
  // Some services (rare patterns) may only have N-direction data — use it reversed.
  const usable = sequences.length
    ? sequences
    : [...stopSequenceByTrip.values()]
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

  return {
    stations: [...stationsById.values()],
    // stationIds lets clients filter the global station list down to just the ~20-90
    // stations a given route actually serves before doing any per-station geometry
    // matching — without it, matching logic ends up checking every station against every
    // route's shapes (475 stations x 27 routes instead of ~50 x 27), which is the
    // difference between sub-100ms and a multi-second main-thread stall on page load.
    routes: results.map((r) => ({
      routeId: r.routeId,
      color: r.color,
      track: r.track,
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
  DIRECTION_ID_TO_LETTER,
  // Pure internals exposed for tests only — the trip-ID quirk handling here (express-X
  // stripping, single-dot shuttles, nearest-code fallback) took real investigation to get
  // right and is the most regression-prone logic in the codebase.
  _internal: { TRIP_KEY_RE, normalizeTripKey, matchStaticTrip, FALLBACK_CODE_TOLERANCE },
};
