const REFRESH_MS = 15000; // matches the backend's feed cache TTL
const MAX_RETRY_MS = 60000;

const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([40.75, -73.95], 11);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 19,
}).addTo(map);

// At a zoomed-out view, dozens of full-size train markers on nearby track segments pile
// up into an undifferentiated cluster. Scale them down via a single inherited CSS
// variable instead of resizing every marker's icon individually on each zoom change.
const mapEl = document.getElementById('map');
function markerScaleForZoom(zoom) {
  return Math.min(1, Math.max(0.35, (zoom - 9) / 6));
}
function updateMarkerScale() {
  mapEl.style.setProperty('--marker-scale', markerScaleForZoom(map.getZoom()));
}
map.on('zoom', updateMarkerScale);
updateMarkerScale();

// The per-tick glide transition (see map.css) must be off during ANY zoom, or markers
// visibly lag/float away from the map instead of scaling with it. Relying on Leaflet's
// own .leaflet-zoom-anim class covers button/programmatic zoom but not touch pinch-zoom
// reliably (seen on mobile) — zoomstart/zoomend fire for every zoom interaction method.
map.on('zoomstart', () => mapEl.classList.add('zooming'));
map.on('zoomend', () => mapEl.classList.remove('zooming'));

const vehicleMarkers = new Map(); // tripId -> L.marker
const vehicleSegments = new Map(); // tripId -> { routeId, segment, status, delaySeconds, currentStatus, destination }
const stationNamesById = new Map(); // base stopId -> station name
const trackIndex = createTrackIndex();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bulletHtml(routeId) {
  const color = trackIndex.routeColors.get(routeId) || DEFAULT_ROUTE_COLOR;
  // Light bullets (N/Q/R/W yellow, L gray) use dark text on real MTA signage — white
  // would be unreadable on them.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const textColor = 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#0b0f14' : '#fff';
  return `<span class="popup-bullet" style="background:${color};color:${textColor}">${esc(routeId)}</span>`;
}

function statusHtml(status, delaySeconds) {
  if (status === 'delayed') return `<span class="popup-status delayed">Delayed ${Math.max(1, Math.round(delaySeconds / 60))} min</span>`;
  if (status === 'on-time') return `<span class="popup-status on-time">On time</span>`;
  return `<span class="popup-status unknown">Status unknown</span>`;
}

function minutesLabel(timeMs) {
  const mins = Math.max(0, Math.round((timeMs - Date.now()) / 60000));
  return mins < 1 ? 'due' : `${mins} min`;
}

function renderTrainPopup(tripId) {
  const v = vehicleSegments.get(tripId);
  if (!v) return 'Trip ended';

  const destination = v.destination ? ` <span class="popup-dest-arrow">→ ${esc(v.destination)}</span>` : '';
  const nextStopName = stationNamesById.get(v.segment.toStopId) || v.segment.toStopId;
  const nextLine =
    v.currentStatus === VEHICLE_STATUS_STOPPED_AT
      ? `At ${esc(nextStopName)}`
      : `Next stop: ${esc(nextStopName)} — ${minutesLabel(v.segment.toTimeMs)}`;

  return `<div class="train-popup">
    <div class="popup-title">${bulletHtml(v.routeId)}<strong>${esc(v.routeId)} train</strong>${destination}</div>
    <div>${statusHtml(v.status, v.delaySeconds)}</div>
    <div class="popup-next">${nextLine}</div>
  </div>`;
}

function renderStationPopup(stationName, arrivals) {
  const rows = arrivals
    .slice(0, 8)
    .map((a) => {
      const dest = a.destination ? esc(a.destination) : a.direction === 'N' ? 'Northbound' : 'Southbound';
      return `<div class="popup-arrival">${bulletHtml(a.routeId)}<span class="popup-dest">${dest}</span><span class="popup-mins${a.status === 'delayed' ? ' delayed' : ''}">${minutesLabel(a.time)}</span></div>`;
    })
    .join('');
  return `<div class="station-popup">
    <div class="popup-title"><strong>${esc(stationName)}</strong></div>
    ${rows || '<div class="popup-empty">No upcoming trains</div>'}
  </div>`;
}

// Actual on-screen movement can be just a couple of pixels a second at typical zoom —
// too subtle to notice at a glance. A pulsing glow on actively-moving trains (anything
// other than STOPPED_AT) makes "this one is live" obvious independent of that.
function trainIcon(status, routeColor, currentStatus) {
  const movingClass = currentStatus !== VEHICLE_STATUS_STOPPED_AT ? ' in-transit' : '';
  return L.divIcon({
    className: 'train-icon',
    html: `<div class="train-marker${movingClass}" style="--route-color: ${routeColor || DEFAULT_ROUTE_COLOR}; --status-color: ${STATUS_COLOR[status] || STATUS_COLOR.unknown}"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// Ticks every second so trains crawl continuously between stations instead of only
// jumping when a new poll arrives every REFRESH_MS.
function tickVehiclePositions() {
  const now = Date.now();
  for (const [tripId, { routeId, segment }] of vehicleSegments) {
    const marker = vehicleMarkers.get(tripId);
    if (!marker) continue;
    const pos = trackIndex.positionAlongSegment(routeId, segment, now);
    marker.setLatLng(pos);
    // Leaflet doesn't move an already-open popup along with its marker — keep the (at
    // most one) open train popup glued to the train, with its ETA counting down live.
    if (marker.isPopupOpen()) {
      marker.getPopup().setLatLng(pos);
      marker.setPopupContent(renderTrainPopup(tripId));
    }
  }
}
setInterval(tickVehiclePositions, 1000);

// The 1s interval itself can get throttled while backgrounded (mobile WebViews especially)
// and browsers don't reliably fire it the instant a page becomes visible again — force an
// immediate resync so markers don't sit visibly stale for up to another second after that.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tickVehiclePositions();
});

async function loadGeometry() {
  const res = await fetch('/api/lines/geometry');
  if (!res.ok) throw new Error(`Geometry API error ${res.status}`);
  const { stations, routes } = await res.json();

  for (const route of routes) {
    trackIndex.addRoute(route, stations);

    // Each distinct branch gets its own polyline — a route with 3 physical branches draws
    // 3 lines instead of forcing everything onto whichever single shape happened to be
    // picked, which previously stranded stations on other branches far off the drawn line.
    const shapes = [...(route.track.N || []), ...(route.track.S || [])];
    for (const shape of shapes) {
      L.polyline(shape, { color: route.color || DEFAULT_ROUTE_COLOR, weight: 3, opacity: 0.6 }).addTo(map);
    }
  }

  const stationLayer = L.layerGroup();
  const stationMarkers = [];
  for (const station of stations) {
    stationNamesById.set(station.stopId, station.name);

    const marker = L.circleMarker([station.lat, station.lon], {
      radius: 4,
      color: '#e6edf3',
      fillColor: '#0b0f14',
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(station.name, { direction: 'top' })
      .bindPopup('Loading…', { maxWidth: 300 })
      .addTo(stationLayer);

    // Arrivals are fetched fresh on every open — the popup may sit open a while, but
    // the times shown are from tap time, which matches rider expectations ("what's
    // coming when I tapped"), and re-tapping refreshes.
    marker.on('popupopen', async (e) => {
      e.popup.setContent('Loading…');
      try {
        const res = await fetch(`/api/stops/${station.stopId}/arrivals`);
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const { arrivals } = await res.json();
        e.popup.setContent(renderStationPopup(station.name, arrivals));
      } catch (err) {
        e.popup.setContent(`Couldn't load arrivals: ${esc(err.message)}`);
      }
    });

    stationMarkers.push(marker);
  }

  // At a zoomed-out, city-wide view, hundreds of station dots across dozens of lines is
  // mostly clutter — only show them once zoomed in enough to actually tell stations apart,
  // and scale their size down at the lower end of that range so they stay unobtrusive.
  const STATION_VISIBILITY_ZOOM = 12;
  function radiusForZoom(zoom) {
    return Math.min(6, Math.max(2, zoom - 9));
  }
  function updateStationDisplay() {
    const zoom = map.getZoom();
    const shouldShow = zoom >= STATION_VISIBILITY_ZOOM;
    const isShown = map.hasLayer(stationLayer);
    if (shouldShow && !isShown) stationLayer.addTo(map);
    else if (!shouldShow && isShown) map.removeLayer(stationLayer);

    if (shouldShow) {
      const radius = radiusForZoom(zoom);
      for (const marker of stationMarkers) marker.setRadius(radius);
    }
  }
  map.on('zoomend', updateStationDisplay);
  updateStationDisplay();
}

function updateVehicles(vehicles) {
  const seenTripIds = new Set();
  const now = Date.now();

  for (const v of vehicles) {
    if (!v.segment) continue;
    seenTripIds.add(v.tripId);
    vehicleSegments.set(v.tripId, {
      routeId: v.routeId,
      segment: v.segment,
      status: v.status,
      delaySeconds: v.delaySeconds,
      currentStatus: v.currentStatus,
      destination: v.destination,
    });

    const existing = vehicleMarkers.get(v.tripId);
    if (existing) {
      // Don't rely solely on the 1s tick to keep existing markers positioned — mobile
      // WebViews commonly throttle/pause JS timers when not the frontmost active view,
      // which would otherwise freeze a marker mid-segment until the timer resumes (then
      // jump). Resyncing here bounds any such freeze to at most one poll interval.
      existing.setIcon(trainIcon(v.status, trackIndex.routeColors.get(v.routeId), v.currentStatus));
      existing.setLatLng(trackIndex.positionAlongSegment(v.routeId, v.segment, now));
      if (existing.isPopupOpen()) existing.setPopupContent(renderTrainPopup(v.tripId));
    } else {
      const tooltip = v.destination ? `${v.routeId} train → ${v.destination}` : `${v.routeId} train`;
      const marker = L.marker(trackIndex.positionAlongSegment(v.routeId, v.segment, now), {
        icon: trainIcon(v.status, trackIndex.routeColors.get(v.routeId), v.currentStatus),
      })
        .bindTooltip(tooltip, { direction: 'top' })
        .bindPopup(() => renderTrainPopup(v.tripId), { maxWidth: 300 })
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
