const REFRESH_MS = 15000; // matches the backend's feed cache TTL
const MAX_RETRY_MS = 60000;
const AUTO_RELOAD_MS = 6 * 60 * 60 * 1000; // cheap insurance against long-run memory bloat/stuck state

// Fully locked view — this runs unattended on a lobby screen, nobody's zooming or panning it.
const map = L.map('map', {
  zoomControl: false,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  touchZoom: false,
  boxZoom: false,
  keyboard: false,
  attributionControl: true,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  maxZoom: 19,
}).addTo(map);

const vehicleMarkers = new Map(); // tripId -> L.marker
const vehicleSegments = new Map(); // tripId -> { routeId, segment }
const trackIndex = createTrackIndex();

function trainIcon(status, routeColor, currentStatus) {
  const movingClass = currentStatus !== VEHICLE_STATUS_STOPPED_AT ? ' in-transit' : '';
  return L.divIcon({
    className: 'train-icon',
    html: `<div class="train-marker${movingClass}" style="--route-color: ${routeColor || DEFAULT_ROUTE_COLOR}; --status-color: ${STATUS_COLOR[status] || STATUS_COLOR.unknown}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function tickVehiclePositions() {
  const now = Date.now();
  for (const [tripId, { routeId, segment }] of vehicleSegments) {
    const marker = vehicleMarkers.get(tripId);
    if (marker) marker.setLatLng(trackIndex.positionAlongSegment(routeId, segment, now));
  }
}
setInterval(tickVehiclePositions, 1000);

async function loadGeometry() {
  const res = await fetch('/api/lines/geometry');
  if (!res.ok) throw new Error(`Geometry API error ${res.status}`);
  const { stations, routes } = await res.json();

  for (const route of routes) {
    trackIndex.addRoute(route, stations);

    const shapes = [...(route.track.N || []), ...(route.track.S || [])];
    for (const shape of shapes) {
      L.polyline(shape, { color: route.color || DEFAULT_ROUTE_COLOR, weight: 4, opacity: 0.75 }).addTo(map);
    }
  }

  // Fit to whatever the system's actual geographic extent is rather than a guessed
  // center/zoom, so this keeps working correctly if routes are added or removed later.
  const bounds = L.latLngBounds(stations.map((s) => [s.lat, s.lon]));
  map.fitBounds(bounds, { padding: [30, 30] });
}

function updateVehicles(vehicles) {
  const seenTripIds = new Set();
  const now = Date.now();

  for (const v of vehicles) {
    if (!v.segment) continue;
    seenTripIds.add(v.tripId);
    vehicleSegments.set(v.tripId, { routeId: v.routeId, segment: v.segment });

    const existing = vehicleMarkers.get(v.tripId);
    if (existing) {
      // Don't rely solely on the 1s tick to keep existing markers positioned — WebViews/
      // backgrounded tabs commonly throttle JS timers, which would otherwise freeze a
      // marker mid-segment until the timer resumes (then jump). Resyncing here bounds
      // any such freeze to at most one poll interval.
      existing.setIcon(trainIcon(v.status, trackIndex.routeColors.get(v.routeId), v.currentStatus));
      existing.setLatLng(trackIndex.positionAlongSegment(v.routeId, v.segment, now));
    } else {
      const marker = L.marker(trackIndex.positionAlongSegment(v.routeId, v.segment, now), {
        icon: trainIcon(v.status, trackIndex.routeColors.get(v.routeId), v.currentStatus),
      }).addTo(map);
      vehicleMarkers.set(v.tripId, marker);
    }
  }

  for (const [tripId, marker] of vehicleMarkers) {
    if (!seenTripIds.has(tripId)) {
      map.removeLayer(marker);
      vehicleMarkers.delete(tripId);
      vehicleSegments.delete(tripId);
    }
  }
}

let consecutiveErrors = 0;

async function refresh() {
  const statusText = document.getElementById('status-text');
  try {
    const res = await fetch('/api/lines');
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();

    updateVehicles(data.vehicles);

    consecutiveErrors = 0;
    statusText.textContent = `${data.vehicles.length} trains live`;
    setTimeout(refresh, REFRESH_MS);
  } catch (err) {
    // Keep the last-known-good map showing rather than blanking out on an unattended
    // screen — just note it quietly and keep retrying with backoff.
    consecutiveErrors += 1;
    const retryDelay = Math.min(REFRESH_MS * 2 ** consecutiveErrors, MAX_RETRY_MS);
    statusText.textContent = `Reconnecting…`;
    setTimeout(refresh, retryDelay);
  }
}

function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
setInterval(updateClock, 1000);
updateClock();

// Best-effort — not supported everywhere, and can be silently revoked by the browser
// (e.g. on tab visibility change), so re-request rather than treating failure as fatal.
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    await navigator.wakeLock.request('screen');
  } catch {
    // Ignore — a lobby screen without wake lock support just relies on its own display settings.
  }
}
requestWakeLock();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    // The 1s tick can get throttled while backgrounded and doesn't reliably fire the
    // instant a page becomes visible again — force an immediate resync.
    tickVehiclePositions();
  }
});

// Service alerts, rotating one at a time — a lobby screen has room for the "why is my
// line red" context that the map markers alone can't carry.
const ALERTS_REFRESH_MS = 60000;
const ALERT_ROTATE_MS = 10000;
let kioskAlerts = [];
let alertIndex = 0;

function escText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function alertBullet(routeId) {
  const color = trackIndex.routeColors.get(routeId) || DEFAULT_ROUTE_COLOR;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const textColor = 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#0b0f14' : '#fff';
  return `<span class="alert-bullet" style="background:${color};color:${textColor}">${escText(routeId)}</span>`;
}

function renderKioskAlert() {
  const el = document.getElementById('alerts');
  if (!kioskAlerts.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  alertIndex %= kioskAlerts.length;
  const a = kioskAlerts[alertIndex];
  const counter = kioskAlerts.length > 1 ? `<span class="alert-counter">${alertIndex + 1}/${kioskAlerts.length}</span>` : '';
  el.innerHTML = `${a.routeIds.map(alertBullet).join('')}<span class="alert-text">${escText(a.header)}</span>${counter}`;
}

async function refreshKioskAlerts() {
  try {
    const res = await fetch('/api/alerts');
    if (res.ok) {
      kioskAlerts = (await res.json()).alerts;
      renderKioskAlert();
    }
  } catch {
    // Non-critical — keep showing the last known alerts.
  }
  setTimeout(refreshKioskAlerts, ALERTS_REFRESH_MS);
}
refreshKioskAlerts();

setInterval(() => {
  if (kioskAlerts.length > 1) {
    alertIndex++;
    renderKioskAlert();
  }
}, ALERT_ROTATE_MS);

setTimeout(() => location.reload(), AUTO_RELOAD_MS);

loadGeometry()
  .then(refresh)
  .catch((err) => {
    document.getElementById('status-text').textContent = `Error: ${err.message}`;
  });
