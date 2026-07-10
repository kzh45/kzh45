const REFRESH_MS = 15000; // matches the backend's feed cache TTL
const MAX_RETRY_MS = 60000;

const STATUS_COLOR = {
  'on-time': '#2ecc71',
  delayed: '#e0333c',
  unknown: '#8b98a5',
};

const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([40.7484, -73.9], 12);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 19,
}).addTo(map);

const vehicleMarkers = new Map(); // tripId -> L.marker

function trainIcon(status) {
  return L.divIcon({
    className: 'train-icon',
    html: `<div class="train-marker" style="--status-color: ${STATUS_COLOR[status] || STATUS_COLOR.unknown}"></div>`,
    iconSize: [16, 16],
  });
}

async function loadGeometry() {
  const res = await fetch('/api/7train/geometry');
  if (!res.ok) throw new Error(`Geometry API error ${res.status}`);
  const { stations, track } = await res.json();

  const trackLatLngs = (track.S && track.S.length ? track.S : track.N).map(([lat, lon]) => [lat, lon]);
  L.polyline(trackLatLngs, { color: '#b933ad', weight: 3, opacity: 0.6 }).addTo(map);

  for (const station of stations) {
    L.circleMarker([station.lat, station.lon], {
      radius: 4,
      color: '#e6edf3',
      fillColor: '#0b0f14',
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(station.name, { direction: 'top' })
      .addTo(map);
  }
}

function updateVehicles(vehicles) {
  const seenTripIds = new Set();

  for (const v of vehicles) {
    if (v.lat == null || v.lon == null) continue;
    seenTripIds.add(v.tripId);

    const existing = vehicleMarkers.get(v.tripId);
    if (existing) {
      existing.setLatLng([v.lat, v.lon]);
      existing.setIcon(trainIcon(v.status));
    } else {
      const marker = L.marker([v.lat, v.lon], { icon: trainIcon(v.status) })
        .bindTooltip(v.tripId, { direction: 'top' })
        .addTo(map);
      vehicleMarkers.set(v.tripId, marker);
    }
  }

  // Remove markers for trips no longer in the feed (completed/unassigned).
  for (const [tripId, marker] of vehicleMarkers) {
    if (!seenTripIds.has(tripId)) {
      map.removeLayer(marker);
      vehicleMarkers.delete(tripId);
    }
  }
}

let consecutiveErrors = 0;
let pendingRetryId = null;

async function refresh() {
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const spinner = document.getElementById('status-spinner');
  const retryBtn = document.getElementById('retry-btn');

  clearTimeout(pendingRetryId);
  spinner.hidden = false;
  retryBtn.hidden = true;

  try {
    const res = await fetch('/api/7train');
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();

    updateVehicles(data.vehicles);

    consecutiveErrors = 0;
    statusEl.classList.remove('error');
    statusText.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()} — ${data.vehicles.length} trains`;
    spinner.hidden = true;

    pendingRetryId = setTimeout(refresh, REFRESH_MS);
  } catch (err) {
    consecutiveErrors += 1;
    const retryDelay = Math.min(REFRESH_MS * 2 ** consecutiveErrors, MAX_RETRY_MS);

    statusEl.classList.add('error');
    statusText.textContent = `Error loading data: ${err.message} — retrying in ${Math.round(retryDelay / 1000)}s`;
    spinner.hidden = true;
    retryBtn.hidden = false;

    pendingRetryId = setTimeout(refresh, retryDelay);
  }
}

document.getElementById('retry-btn').addEventListener('click', refresh);

loadGeometry()
  .then(refresh)
  .catch((err) => {
    document.getElementById('status-text').textContent = `Error loading map: ${err.message}`;
  });
