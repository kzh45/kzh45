require('dotenv').config({ quiet: true });
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

// The 7 train doesn't have its own feed under the current MTA endpoint —
// it's bundled into the bare "gtfs" feed alongside 1/2/3/4/5/6/S.
const FEED_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';

async function fetchRouteUpdates(routeId) {
  // As of nyct-gtfs v2.0.0 / MTA's current endpoint, API keys are no longer required.
  const apiKey = process.env.MTA_API_KEY;
  const headers = apiKey ? { 'x-api-key': apiKey } : {};

  const response = await fetch(FEED_URL, { headers });
  if (!response.ok) {
    throw new Error(`MTA feed request failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

  const trips = [];
  const vehicles = [];

  for (const entity of feed.entity) {
    if (entity.tripUpdate && entity.tripUpdate.trip.routeId === routeId) {
      const trip = entity.tripUpdate.trip;
      trips.push({
        tripId: trip.tripId,
        routeId: trip.routeId,
        stopTimeUpdates: entity.tripUpdate.stopTimeUpdate.map((stu) => ({
          stopId: stu.stopId,
          arrival: stu.arrival ? stu.arrival.time * 1000 : null,
          departure: stu.departure ? stu.departure.time * 1000 : null,
        })),
      });
    } else if (entity.vehicle && entity.vehicle.trip?.routeId === routeId) {
      const v = entity.vehicle;
      vehicles.push({
        tripId: v.trip?.tripId,
        stopId: v.stopId,
        currentStatus: v.currentStatus,
      });
    }
  }

  return { fetchedAt: Date.now(), trips, vehicles };
}

module.exports = { fetchRouteUpdates };
