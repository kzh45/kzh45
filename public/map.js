const REFRESH_MS = 15000; // matches the backend's feed cache TTL
const MAX_RETRY_MS = 60000;

const STATUS_COLOR = {
  'on-time': '#2ecc71',
  delayed: '#e0333c',
  unknown: '#8b98a5',
};
const DEFAULT_ROUTE_COLOR = '#b933ad';

const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([40.75, -73.95], 11);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 19,
}).addTo(map);

const vehicleMarkers = new Map(); // tripId -> L.marker
const vehicleSegments = new Map(); // tripId -> { routeId, segment }

function trainIcon(status, routeColor) {
  return L.divIcon({
    className: 'train-icon',
    html: `<div class="train-marker" style="--route-color: ${routeColor || DEFAULT_ROUTE_COLOR}; --status-color: ${STATUS_COLOR[status] || STATUS_COLOR.unknown}"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// Track polylines and each station's nearest point index along them, per route+direction,
// so a train's position can walk the real (curved) track between stations instead of
// cutting a straight line through — populated once loadGeometry() has fetched the data.
const trackByRoute = new Map(); // routeId -> { N: [[lat,lon],...], S: [...] }
const stationIndexByRoute = new Map(); // routeId -> { N: Map(stopId->idx), S: Map(...) }
const routeColors = new Map(); // routeId -> "#rrggbb"
const subPathCache = new Map(); // "routeId|direction|fromStopId|toStopId" -> { points, cumDist, total }

function metersPerDegree(lat) {
  // Cheap equirectangular approximation — plenty accurate at NYC's scale/latitude.
  return { lat: 111320, lon: 111320 * Math.cos((lat * Math.PI) / 180) };
}

function distanceMeters([lat1, lon1], [lat2, lon2]) {
  const { lat: mLat, lon: mLon } = metersPerDegree((lat1 + lat2) / 2);
  const dy = (lat2 - lat1) * mLat;
  const dx = (lon2 - lon1) * mLon;
  return Math.sqrt(dx * dx + dy * dy);
}

function nearestPointIndex(track, lat, lon) {
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < track.length; i++) {
    const d = distanceMeters(track[i], [lat, lon]);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function getSubPath(routeId, direction, fromStopId, toStopId) {
  const cacheKey = `${routeId}|${direction}|${fromStopId}|${toStopId}`;
  const cached = subPathCache.get(cacheKey);
  if (cached) return cached;

  const track = trackByRoute.get(routeId)?.[direction];
  const indexByStop = stationIndexByRoute.get(routeId)?.[direction];
  let result = null;

  if (track && indexByStop && indexByStop.has(fromStopId) && indexByStop.has(toStopId)) {
    const fromIdx = indexByStop.get(fromStopId);
    const toIdx = indexByStop.get(toStopId);
    const points = fromIdx <= toIdx ? track.slice(fromIdx, toIdx + 1) : track.slice(toIdx, fromIdx + 1).reverse();

    const cumDist = [0];
    for (let i = 1; i < points.length; i++) {
      cumDist.push(cumDist[i - 1] + distanceMeters(points[i - 1], points[i]));
    }
    result = { points, cumDist, total: cumDist[cumDist.length - 1] };
  }

  subPathCache.set(cacheKey, result);
  return result;
}

function pointAtDistance(subPath, targetDist) {
  const { points, cumDist, total } = subPath;
  if (total === 0) return points[0];
  const clamped = Math.min(total, Math.max(0, targetDist));

  for (let i = 1; i < cumDist.length; i++) {
    if (cumDist[i] >= clamped) {
      const segLen = cumDist[i] - cumDist[i - 1];
      const segFraction = segLen > 0 ? (clamped - cumDist[i - 1]) / segLen : 0;
      const [lat1, lon1] = points[i - 1];
      const [lat2, lon2] = points[i];
      return [lat1 + (lat2 - lat1) * segFraction, lon1 + (lon2 - lon1) * segFraction];
    }
  }
  return points[points.length - 1];
}

function positionAlongSegment(routeId, segment, now) {
  const duration = segment.toTimeMs - segment.fromTimeMs;
  const fraction = duration > 0 ? Math.min(1, Math.max(0, (now - segment.fromTimeMs) / duration)) : 1;

  const subPath = getSubPath(routeId, segment.direction, segment.fromStopId, segment.toStopId);
  if (subPath) return pointAtDistance(subPath, subPath.total * fraction);

  // Fall back to a straight line if the track/station lookup wasn't available.
  return [
    segment.fromLat + (segment.toLat - segment.fromLat) * fraction,
    segment.fromLon + (segment.toLon - segment.fromLon) * fraction,
  ];
}

// Ticks every second so trains crawl continuously between stations instead of only
// jumping when a new poll arrives every REFRESH_MS.
function tickVehiclePositions() {
  const now = Date.now();
  for (const [tripId, { routeId, segment }] of vehicleSegments) {
    const marker = vehicleMarkers.get(tripId);
    if (marker) marker.setLatLng(positionAlongSegment(routeId, segment, now));
  }
}
setInterval(tickVehiclePositions, 1000);

async function loadGeometry() {
  const res = await fetch('/api/lines/geometry');
  if (!res.ok) throw new Error(`Geometry API error ${res.status}`);
  const { stations, routes } = await res.json();

  for (const route of routes) {
    routeColors.set(route.routeId, route.color || DEFAULT_ROUTE_COLOR);

    const directions = {};
    const indexByDirection = {};
    for (const direction of ['N', 'S']) {
      if (!route.track[direction] || !route.track[direction].length) continue;
      directions[direction] = route.track[direction];
      indexByDirection[direction] = new Map(
        stations.map((s) => [s.stopId, nearestPointIndex(route.track[direction], s.lat, s.lon)])
      );
    }
    trackByRoute.set(route.routeId, directions);
    stationIndexByRoute.set(route.routeId, indexByDirection);

    const trackLatLngs = (route.track.S?.length ? route.track.S : route.track.N || []).map(([lat, lon]) => [lat, lon]);
    if (trackLatLngs.length) {
      L.polyline(trackLatLngs, { color: route.color || DEFAULT_ROUTE_COLOR, weight: 3, opacity: 0.6 }).addTo(map);
    }
  }

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
  const now = Date.now();

  for (const v of vehicles) {
    if (!v.segment) continue;
    seenTripIds.add(v.tripId);
    vehicleSegments.set(v.tripId, { routeId: v.routeId, segment: v.segment });

    const existing = vehicleMarkers.get(v.tripId);
    if (existing) {
      existing.setIcon(trainIcon(v.status, routeColors.get(v.routeId)));
    } else {
      const marker = L.marker(positionAlongSegment(v.routeId, v.segment, now), {
        icon: trainIcon(v.status, routeColors.get(v.routeId)),
      })
        .bindTooltip(`${v.routeId} train — ${v.tripId}`, { direction: 'top' })
        .addTo(map);
      vehicleMarkers.set(v.tripId, marker);
    }
  }

  // Remove markers for trips no longer in the feed (completed/unassigned).
  for (const [tripId, marker] of vehicleMarkers) {
    if (!seenTripIds.has(tripId)) {
      map.removeLayer(marker);
      vehicleMarkers.delete(tripId);
      vehicleSegments.delete(tripId);
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
    const res = await fetch('/api/lines');
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
