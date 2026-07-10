const { fetchRouteUpdates } = require('./mta');

async function main() {
  const { trips, vehicles } = await fetchRouteUpdates('7');

  for (const trip of trips) {
    console.log(`\nTrip ${trip.tripId} (route ${trip.routeId})`);
    for (const stu of trip.stopTimeUpdates) {
      const arrival = stu.arrival ? new Date(stu.arrival).toLocaleTimeString() : '—';
      const departure = stu.departure ? new Date(stu.departure).toLocaleTimeString() : '—';
      console.log(`  stop ${stu.stopId}: arr ${arrival} dep ${departure}`);
    }
  }

  for (const v of vehicles) {
    console.log(`\nVehicle on trip ${v.tripId}: at stop ${v.stopId}, status ${v.currentStatus}`);
  }
}

main().catch((err) => {
  console.error('Error fetching 7 train feed:', err.message);
  process.exit(1);
});
