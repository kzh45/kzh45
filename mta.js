require('dotenv').config({ quiet: true });
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { getScheduledTimeMs } = require('./gtfs-static');

// A prediction within this many seconds of its scheduled time counts as "on-time".
const DELAY_THRESHOLD_SECONDS = 120;

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

async function fetchRouteUpdates(routeId) {
  const { fetchedAt, entities } = await fetchFeed();

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
        stopId: v.stopId,
        currentStatus: v.currentStatus,
      });
    }
  }

  return { fetchedAt, trips, vehicles };
}

module.exports = { fetchRouteUpdates };
