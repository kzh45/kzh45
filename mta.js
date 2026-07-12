require('dotenv').config({ quiet: true });
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { getScheduledTimeMs, getAdjacentStopId, getTripHeadsign, getGeometry } = require('./gtfs-static');

// A prediction within this many seconds of its scheduled time counts as "on-time".
const DELAY_THRESHOLD_SECONDS = 120;

// Beyond this, the "delay" is almost certainly a service-day mismatch in trip matching
// (a ±24h artifact), not a real delay — report "unknown" rather than a lie. Genuine
// delays this large mean suspended service, where unknown is the honest answer too.
const SANITY_DELAY_SECONDS = 3 * 3600;

const VEHICLE_STATUS = { INCOMING_AT: 0, STOPPED_AT: 1, IN_TRANSIT_TO: 2 };

// Used when the previous station has no static-schedule match (rare — e.g. an
// unscheduled extra train), so we still get some motion instead of a static snap.
const DEFAULT_SEGMENT_MS = 90 * 1000;

// No GPS is available for NYCT vehicles. Instead of a single guessed point, return a
// time-bounded segment (previous station -> target station, with real/estimated start
// and end timestamps) so the client can continuously animate the train's position every
// second rather than only jumping when new poll data arrives. The previous station comes
// from the matched trip's own scheduled stop sequence (not a hardcoded line order), so
// this works correctly on branching/skip-stop lines too.
async function computeVehicleSegment(routeId, stations, targetStopId, currentStatus, tripId, predictedArrivalMs, delaySeconds, now) {
  const direction = targetStopId.slice(-1);
  const targetBaseStopId = targetStopId.slice(0, -1);
  const target = stations.get(targetBaseStopId);
  if (!target) return null;

  const atStation = () => ({
    fromStopId: targetBaseStopId, toStopId: targetBaseStopId, direction,
    fromLat: target.lat, fromLon: target.lon, toLat: target.lat, toLon: target.lon,
    fromTimeMs: now, toTimeMs: now,
  });

  if (currentStatus === VEHICLE_STATUS.STOPPED_AT || !predictedArrivalMs) return atStation();

  const prevStopId = await getAdjacentStopId(routeId, tripId, targetStopId, predictedArrivalMs);
  const prevBaseStopId = prevStopId?.slice(0, -1);
  const prev = prevBaseStopId ? stations.get(prevBaseStopId) : null;
  if (!prev) return atStation();

  // Reuse the trip's already-known delay to avoid a second async schedule lookup:
  // scheduled(target) = predicted(target) - delay.
  const scheduledTargetMs = delaySeconds != null ? predictedArrivalMs - delaySeconds * 1000 : predictedArrivalMs;
  const scheduledPrevMs = await getScheduledTimeMs(routeId, tripId, prevStopId, predictedArrivalMs);

  const segmentDurationMs =
    scheduledPrevMs != null && scheduledTargetMs - scheduledPrevMs > 0
      ? scheduledTargetMs - scheduledPrevMs
      : DEFAULT_SEGMENT_MS;

  return {
    fromStopId: prevBaseStopId,
    toStopId: targetBaseStopId,
    direction,
    fromLat: prev.lat,
    fromLon: prev.lon,
    toLat: target.lat,
    toLon: target.lon,
    fromTimeMs: predictedArrivalMs - segmentDurationMs,
    toTimeMs: predictedArrivalMs,
  };
}

// NYCT splits the system across 7 separate GTFS-RT feeds, grouped roughly by which
// physical lines interline. The numbered lines (plus their express variants and the 42nd
// St Shuttle) share one bare feed; each lettered group has its own.
const FEED_BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/';
const FEED_GROUPS = {
  'nyct%2Fgtfs': ['1', '2', '3', '4', '5', '6', '6X', '7', '7X', 'GS'],
  'nyct%2Fgtfs-ace': ['A', 'C', 'E', 'H'],
  'nyct%2Fgtfs-bdfm': ['B', 'D', 'F', 'M', 'FS'], // the Franklin Ave Shuttle is bundled here, not with ACE
  'nyct%2Fgtfs-g': ['G'],
  'nyct%2Fgtfs-jz': ['J', 'Z'],
  'nyct%2Fgtfs-l': ['L'],
  'nyct%2Fgtfs-nqrw': ['N', 'Q', 'R', 'W'],
};

const ROUTE_TO_FEED_URL = new Map();
const ALL_ROUTE_IDS = [];
for (const [path, routeIds] of Object.entries(FEED_GROUPS)) {
  for (const routeId of routeIds) {
    ROUTE_TO_FEED_URL.set(routeId, FEED_BASE + path);
    ALL_ROUTE_IDS.push(routeId);
  }
}

// Each underlying feed only updates every ~30s, so cache each decoded feed briefly
// instead of re-fetching and re-decoding it on every client request. Cached per feed URL
// since each of NYCT's 7 feeds is a separate network request.
const CACHE_TTL_MS = 15000;
const feedCache = new Map(); // url -> { fetchedAt, entities }
const feedInFlight = new Map(); // url -> Promise

// Lightweight liveness stats, surfaced via /healthz so a kiosk stuck on "Reconnecting…"
// is diagnosable without shell access to the box.
const stats = { lastFeedSuccessMs: null, feedFetches: 0, feedErrors: 0 };
function getStats() {
  return {
    ...stats,
    lastFeedSuccessAgeSeconds:
      stats.lastFeedSuccessMs == null ? null : Math.round((Date.now() - stats.lastFeedSuccessMs) / 1000),
  };
}

async function fetchFeed(feedUrl) {
  const cached = feedCache.get(feedUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  if (!feedInFlight.has(feedUrl)) {
    feedInFlight.set(
      feedUrl,
      (async () => {
        // As of nyct-gtfs v2.0.0 / MTA's current endpoint, API keys are no longer required.
        const apiKey = process.env.MTA_API_KEY;
        const headers = apiKey ? { 'x-api-key': apiKey } : {};

        try {
          const response = await fetch(feedUrl, { headers });
          if (!response.ok) {
            throw new Error(`MTA feed request failed: ${response.status} ${response.statusText}`);
          }

          const buffer = await response.arrayBuffer();
          const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

          const result = { fetchedAt: Date.now(), entities: feed.entity };
          feedCache.set(feedUrl, result);
          stats.feedFetches += 1;
          stats.lastFeedSuccessMs = result.fetchedAt;
          return result;
        } catch (err) {
          stats.feedErrors += 1;
          throw err;
        }
      })().finally(() => {
        feedInFlight.delete(feedUrl);
      })
    );
  }

  return feedInFlight.get(feedUrl);
}

// The trip-matching/delay/interpolation work below is the expensive part (hundreds of
// static-schedule lookups per call) — cache its result per route too, not just the raw
// feed fetch, so concurrent pollers (web list, map, mobile) within the same 15s window
// share one computed result instead of each redoing all of it from scratch.
const routeUpdatesCache = new Map(); // routeId -> { cachedAt, data }
const routeUpdatesInFlight = new Map(); // routeId -> Promise

async function fetchRouteUpdates(routeId) {
  const cached = routeUpdatesCache.get(routeId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  if (!routeUpdatesInFlight.has(routeId)) {
    routeUpdatesInFlight.set(
      routeId,
      computeRouteUpdates(routeId)
        .then((data) => {
          routeUpdatesCache.set(routeId, { cachedAt: Date.now(), data });
          return data;
        })
        .finally(() => {
          routeUpdatesInFlight.delete(routeId);
        })
    );
  }

  return routeUpdatesInFlight.get(routeId);
}

async function computeRouteUpdates(routeId) {
  const feedUrl = ROUTE_TO_FEED_URL.get(routeId);
  if (!feedUrl) throw new Error(`Unknown routeId: ${routeId}`);

  const [{ fetchedAt, entities }, { stations }] = await Promise.all([fetchFeed(feedUrl), getGeometry(routeId)]);
  const stationById = new Map(stations.map((s) => [s.stopId, s]));

  const trips = [];
  const vehicles = [];

  for (const entity of entities) {
    if (entity.tripUpdate && entity.tripUpdate.trip.routeId === routeId) {
      const trip = entity.tripUpdate.trip;
      const stopTimeUpdates = await Promise.all(
        entity.tripUpdate.stopTimeUpdate.map(async (stu) => {
          const arrival = stu.arrival ? stu.arrival.time * 1000 : null;
          const departure = stu.departure ? stu.departure.time * 1000 : null;
          const predicted = arrival || departure;

          // The predicted time is the reference that disambiguates which service DAY the
          // trip belongs to (late-night yesterday spillover vs pre-assigned tomorrow trips).
          const scheduled = predicted
            ? await getScheduledTimeMs(routeId, trip.tripId, stu.stopId, predicted)
            : null;
          let delaySeconds = scheduled != null ? Math.round((predicted - scheduled) / 1000) : null;
          if (delaySeconds != null && Math.abs(delaySeconds) > SANITY_DELAY_SECONDS) delaySeconds = null;
          const status =
            delaySeconds == null ? 'unknown' : delaySeconds > DELAY_THRESHOLD_SECONDS ? 'delayed' : 'on-time';

          return { stopId: stu.stopId, arrival, departure, delaySeconds, status };
        })
      );

      trips.push({ tripId: trip.tripId, routeId: trip.routeId, stopTimeUpdates });
    } else if (entity.vehicle && entity.vehicle.trip?.routeId === routeId) {
      const v = entity.vehicle;
      vehicles.push({
        tripId: v.trip?.tripId,
        routeId,
        stopId: v.stopId,
        currentStatus: v.currentStatus,
      });
    }
  }

  const stopTimesByTrip = new Map(trips.map((t) => [t.tripId, t.stopTimeUpdates]));
  await Promise.all(
    vehicles.map(async (v) => {
      if (!v.stopId) return;

      const stopTimes = stopTimesByTrip.get(v.tripId) || [];
      const stu = stopTimes.find((s) => s.stopId === v.stopId) || stopTimes[0];
      v.status = stu?.status ?? 'unknown';
      v.delaySeconds = stu?.delaySeconds ?? null;

      const predictedArrivalMs = stu?.arrival || stu?.departure || null;
      v.destination = await getTripHeadsign(routeId, v.tripId, v.stopId, predictedArrivalMs || fetchedAt);
      v.segment = await computeVehicleSegment(
        routeId, stationById, v.stopId, v.currentStatus, v.tripId, predictedArrivalMs, v.delaySeconds, fetchedAt
      );
    })
  );

  return { fetchedAt, trips, vehicles };
}

// Fetches multiple routes at once. Since fetchFeed() is cached, this costs one network
// request regardless of how many routeIds share the same underlying feed.
async function fetchLinesUpdates(routeIds) {
  const results = await Promise.all(routeIds.map((id) => fetchRouteUpdates(id)));
  return {
    fetchedAt: results[0]?.fetchedAt ?? Date.now(),
    trips: results.flatMap((r) => r.trips),
    vehicles: results.flatMap((r) => r.vehicles),
  };
}

// MTA's subway service alerts are published as another GTFS-rt feed (same protobuf
// FeedMessage shape, entity.alert instead of tripUpdate/vehicle) — fetchFeed's per-URL
// cache applies as-is.
const ALERTS_FEED_URL = FEED_BASE + 'camsys%2Fsubway-alerts';
const KNOWN_ROUTE_IDS = new Set(ALL_ROUTE_IDS);

// Protobuf uint64 timestamps decode as Long objects in some environments and plain
// numbers in others — coerce either.
function toEpochSeconds(x) {
  if (x && typeof x === 'object' && typeof x.toNumber === 'function') return x.toNumber();
  return Number(x || 0);
}

function pickTranslation(field) {
  const t = field?.translation?.find((x) => x.language === 'en') || field?.translation?.[0];
  return t ? t.text : null;
}

// Currently-active alerts affecting subway routes we serve, most of the feed is
// planned-work notices with future active periods — those are filtered out.
async function fetchServiceAlerts() {
  const { fetchedAt, entities } = await fetchFeed(ALERTS_FEED_URL);
  const nowSec = Date.now() / 1000;

  const alerts = [];
  for (const entity of entities) {
    const alert = entity.alert;
    if (!alert) continue;

    const periods = alert.activePeriod || [];
    const isActive =
      periods.length === 0 ||
      periods.some((p) => {
        const start = toEpochSeconds(p.start);
        const end = toEpochSeconds(p.end);
        return start <= nowSec && (!end || end >= nowSec);
      });
    if (!isActive) continue;

    const routeIds = [
      ...new Set((alert.informedEntity || []).map((ie) => ie.routeId).filter((r) => r && KNOWN_ROUTE_IDS.has(r))),
    ];
    if (!routeIds.length) continue;

    const header = pickTranslation(alert.headerText);
    if (!header) continue;

    alerts.push({ id: entity.id, routeIds, header });
  }

  return { fetchedAt, alerts };
}

// Next arrivals at one station (base stop ID without the N/S platform suffix), across
// all routes and both directions. Reads from the same 15s-cached computed results the
// map polls, so a tap costs no extra upstream fetch.
const MAX_STOP_ARRIVALS = 12;

async function getStopArrivals(stopBaseId) {
  const { fetchedAt, trips } = await fetchLinesUpdates(ALL_ROUTE_IDS);
  const now = Date.now();

  const arrivals = [];
  for (const trip of trips) {
    for (const stu of trip.stopTimeUpdates) {
      if (stu.stopId.slice(0, -1) !== stopBaseId) continue;
      const time = stu.arrival || stu.departure;
      if (!time || time < now - 30000) continue; // skip stale/past predictions

      arrivals.push({
        routeId: trip.routeId,
        tripId: trip.tripId,
        stopId: stu.stopId,
        direction: stu.stopId.slice(-1),
        time,
        status: stu.status,
        delaySeconds: stu.delaySeconds,
      });
    }
  }

  arrivals.sort((a, b) => a.time - b.time);
  const next = arrivals.slice(0, MAX_STOP_ARRIVALS);

  await Promise.all(
    next.map(async (a) => {
      a.destination = await getTripHeadsign(a.routeId, a.tripId, a.stopId, a.time);
      delete a.tripId; // internal matching detail, not useful to clients
    })
  );

  return { fetchedAt, arrivals: next };
}

module.exports = { fetchRouteUpdates, fetchLinesUpdates, getStopArrivals, fetchServiceAlerts, getStats, ALL_ROUTE_IDS };
