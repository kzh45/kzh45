// Terminal live-status monitor for one route, polling every 30s with color-coded
// on-time/delayed output. Usage: node poc-live-status.js [routeId]
const { fetchRouteUpdates } = require('./mta');

const routeId = process.argv[2] || '7';

const STATUS_COLOR = {
  'on-time': '\x1b[32m', // green
  delayed: '\x1b[31m', // red
  unknown: '\x1b[90m', // gray
};
const RESET = '\x1b[0m';

// GTFS-RT VehicleStopStatus enum decodes to its raw numeric value here (0/1/2),
// not the string name — that only appears when going through protobufjs's toJSON().
const CURRENT_STATUS_LABEL = {
  0: 'incoming to',
  1: 'stopped at',
  2: 'in transit to',
};

function formatStatus(status, delaySeconds) {
  const color = STATUS_COLOR[status] || STATUS_COLOR.unknown;
  const label = status === 'delayed' ? `delayed ${Math.round(delaySeconds / 60)}m` : status;
  return `${color}${label}${RESET}`;
}

async function poll() {
  const { fetchedAt, trips, vehicles } = await fetchRouteUpdates(routeId);
  const stopTimesByTrip = new Map(trips.map((t) => [t.tripId, t.stopTimeUpdates]));

  console.log(`\n${routeId} train — live status @ ${new Date(fetchedAt).toLocaleTimeString()}`);

  if (!vehicles.length) {
    console.log('  (no active vehicles reported right now)');
    return;
  }

  for (const v of vehicles) {
    const stopTimes = stopTimesByTrip.get(v.tripId) || [];
    const stu = stopTimes.find((s) => s.stopId === v.stopId) || stopTimes[0];

    const eta = stu?.arrival || stu?.departure;
    const etaText = eta ? new Date(eta).toLocaleTimeString() : 'unknown';
    const statusText = stu ? formatStatus(stu.status, stu.delaySeconds) : formatStatus('unknown');
    const label = CURRENT_STATUS_LABEL[v.currentStatus] ?? v.currentStatus;

    console.log(`  Trip ${v.tripId}: ${label} ${v.stopId} — ETA ${etaText} — ${statusText}`);
  }
}

async function main() {
  await poll();
  setInterval(() => {
    poll().catch((err) => console.error('poll error:', err.message));
  }, 30000);
}

main().catch((err) => {
  console.error('Error starting live status PoC:', err.message);
  process.exit(1);
});
