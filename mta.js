require('dotenv').config({ quiet: true });
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { getScheduledTimeMs, getGeometry } = require('./gtfs-static');

// A prediction within this many seconds of its scheduled time counts as "on-time".
const DELAY_THRESHOLD_SECONDS = 120;

// Station order from Flushing to Hudson Yards — used to find a vehicle's previous/next
// station for position interpolation (the feed gives no real GPS, see gtfs-static.js).
const STATION_ORDER = [
  '701', '702', '705', '706', '707', '708', '709', '710', '711', '712', '713',
  '714', '715', '716', '718', '719', '720', '721', '723', '724', '725', '726',
];

const VEHICLE_STATUS = { INCOMING_AT: 0, STOPPED_AT: 1, IN_TRANSIT_TO: 2 };

// No GPS is available for NYCT vehicles, so we approximate a position along the track
// between the previous and next station based on how close the train is to arriving.
function interpolateVehiclePosition(stations, direction, targetStopId, currentStatus) {
  const target = stations.get(targetStopId);
  if (!target) return null;
  if (currentStatus === VEHICLE_STATUS.STOPPED_AT) return { lat: target.lat, lon: target.lon };

  const idx = STATION_ORDER.indexOf(targetStopId);
  const prevIdx = direction === 'S' ? idx - 1 : idx + 1;
  const prev = idx === -1 || prevIdx < 0 || prevIdx >= STATION_ORDER.length
    ? null
    : stations.get(STATION_ORDER[prevIdx]);
  if (!prev) return { lat: target.lat, lon: target.lon };

  const fraction = currentStatus === VEHICLE_STATUS.INCOMING_AT ? 0.85 : 0.45;
  return {
    lat: prev.lat + (target.lat - prev.lat) * fraction,
    lon: prev.lon + (target.lon - prev.lon) * fraction,
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

async function fetchRouteUpdates(routeId) {
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
        stopId: v.stopId,
        currentStatus: v.currentStatus,
      });
    }
  }

  const stopTimesByTrip = new Map(trips.map((t) => [t.tripId, t.stopTimeUpdates]));
  for (const v of vehicles) {
    if (!v.stopId) continue;
    const direction = v.tripId?.slice(-1);
    const baseStopId = v.stopId.slice(0, -1);

    const position = interpolateVehiclePosition(stationById, direction, baseStopId, v.currentStatus);
    v.lat = position?.lat ?? null;
    v.lon = position?.lon ?? null;

    const stopTimes = stopTimesByTrip.get(v.tripId) || [];
    const stu = stopTimes.find((s) => s.stopId === v.stopId) || stopTimes[0];
    v.status = stu?.status ?? 'unknown';
    v.delaySeconds = stu?.delaySeconds ?? null;
  }

  return { fetchedAt, trips, vehicles };
}

module.exports = { fetchRouteUpdates };
