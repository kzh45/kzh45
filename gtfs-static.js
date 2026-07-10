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
const TRIP_KEY_RE = /(\d{6}_[^.]+\.\.[NS])/;

let loaded = null; // { serviceIdsByDate: fn, tripsByKey: Map, stopTimesByTrip: Map }
let loadingPromise = null;

async function ensureStaticData() {
  const isFresh = fs.existsSync(DATA_DIR) && Date.now() - fs.statSync(DATA_DIR).mtimeMs < MAX_AGE_MS;
  if (isFresh) return;

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
}

function parseCalendar() {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
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

  const tripsByKey = new Map(); // key -> [{ tripId, serviceId }]
  const tripIds = new Set();

  for (const line of rows) {
    const [tripRouteId, tripId, serviceId] = line.split(',');
    if (tripRouteId !== routeId) continue;

    const match = tripId.match(TRIP_KEY_RE);
    if (!match) continue;

    const key = match[1];
    if (!tripsByKey.has(key)) tripsByKey.set(key, []);
    tripsByKey.get(key).push({ tripId, serviceId });
    tripIds.add(tripId);
  }

  return { tripsByKey, tripIds };
}

function timeStringToSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

async function parseStopTimesForTrips(tripIds) {
  const stopTimesByTrip = new Map(); // tripId -> Map(stopId -> scheduledSeconds)

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

    const [, stopId, arrivalTime, departureTime] = line.split(',');
    const seconds = timeStringToSeconds(departureTime || arrivalTime);

    if (!stopTimesByTrip.has(tripId)) stopTimesByTrip.set(tripId, new Map());
    stopTimesByTrip.get(tripId).set(stopId, seconds);
  }

  return stopTimesByTrip;
}

async function load(routeId) {
  await ensureStaticData();
  const serviceIdsForDate = parseCalendar();
  const { tripsByKey, tripIds } = parseTripsForRoute(routeId);
  const stopTimesByTrip = await parseStopTimesForTrips(tripIds);
  return { serviceIdsForDate, tripsByKey, stopTimesByTrip };
}

async function getLoaded(routeId) {
  if (loaded) return loaded;
  if (!loadingPromise) {
    loadingPromise = load(routeId).catch((err) => {
      loadingPromise = null; // allow a retry on the next call instead of caching the failure
      throw err;
    });
  }
  loaded = await loadingPromise;
  return loaded;
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
  const { serviceIdsForDate, tripsByKey, stopTimesByTrip } = schedule;

  const match = realtimeTripId.match(TRIP_KEY_RE);
  if (!match) return null;
  const key = match[1];

  const candidates = tripsByKey.get(key);
  if (!candidates || !candidates.length) return null;

  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const activeServiceIds = new Set([...serviceIdsForDate(today), ...serviceIdsForDate(yesterday)]);

  for (const candidate of candidates) {
    if (!activeServiceIds.has(candidate.serviceId)) continue;
    const stopTimes = stopTimesByTrip.get(candidate.tripId);
    if (!stopTimes || !stopTimes.has(stopId)) continue;

    const scheduledSeconds = stopTimes.get(stopId);
    const serviceDayStart = new Date(today);
    serviceDayStart.setHours(0, 0, 0, 0);
    // GTFS times can exceed 24:00:00 for trips continuing past midnight on the same service day.
    return serviceDayStart.getTime() + scheduledSeconds * 1000;
  }

  return null;
}

module.exports = { getScheduledTimeMs };
