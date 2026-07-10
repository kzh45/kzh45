require('dotenv').config({ quiet: true });
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { getScheduledTimeMs, getAdjacentStopId, getGeometry } = require('./gtfs-static');

// A prediction within this many seconds of its scheduled time counts as "on-time".
const DELAY_THRESHOLD_SECONDS = 120;

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

  const prevStopId = await getAdjacentStopId(routeId, tripId, targetStopId, new Date(now));
  const prevBaseStopId = prevStopId?.slice(0, -1);
  const prev = prevBaseStopId ? stations.get(prevBaseStopId) : null;
  if (!prev) return atStation();

  // Reuse the trip's already-known delay to avoid a second async schedule lookup:
  // scheduled(target) = predicted(target) - delay.
  const scheduledTargetMs = delaySeconds != null ? predictedArrivalMs - delaySeconds * 1000 : predictedArrivalMs;
  const scheduledPrevMs = await getScheduledTimeMs(routeId, tripId, prevStopId, new Date(now));

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

// The 7 train doesn't have its own feed under the current MTA endpoint —
// it's bundled into the bare "gtfs" feed alongside 1/2/3/4/5/6/S.
const FEED_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';

// The MTA feed itself only updates every ~30s, so cache the decoded feed briefly
// instead of re-fetching and re-decoding it on every client request.
const CACHE_TTL_MS = 15000;
let cache = null; // { fetchedAt, entities }
let inFlight = null; // Promise, deduped so concurrent requests share one fetch

async function fetchFeed() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  if (!inFlight) {
    inFlight = (async () => {
      // As of nyct-gtfs v2.0.0 / MTA's current endpoint, API keys are no longer required.
      const apiKey = process.env.MTA_API_KEY;
      const headers = apiKey ? { 'x-api-key': apiKey } : {};

      const response = await fetch(FEED_URL, { headers });
      if (!response.ok) {
        throw new Error(`MTA feed request failed: ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

      cache = { fetchedAt: Date.now(), entities: feed.entity };
      return cache;
    })().finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
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
  const [{ fetchedAt, entities }, { stations }] = await Promise.all([fetchFeed(), getGeometry(routeId)]);
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

          const scheduled = predicted
            ? await getScheduledTimeMs(routeId, trip.tripId, stu.stopId)
            : null;
          const delaySeconds = scheduled != null ? Math.round((predicted - scheduled) / 1000) : null;
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

module.exports = { fetchRouteUpdates, fetchLinesUpdates };
