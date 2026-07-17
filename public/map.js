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

const vehicleMarkers = new Map(); // tripId -> L.marker
const vehicleSegments = new Map(); // tripId -> { routeId, segment, status, delaySeconds, currentStatus, destination }
const stationNamesById = new Map(); // base stopId -> station name
const routePolylines = new Map(); // routeId -> [L.polyline per branch]
const trackIndex = createTrackIndex();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Light route colors (N/Q/R/W yellow, L gray) use dark text on real MTA signage — white
// would be unreadable on them.
function textColorFor(color) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#0b0f14' : '#fff';
}

function bulletHtml(routeId) {
  const color = trackIndex.routeColors.get(routeId) || DEFAULT_ROUTE_COLOR;
  return `<span class="popup-bullet" style="background:${color};color:${textColorFor(color)}">${esc(routeId)}</span>`;
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
// Express variants (6X/7X) render as diamonds with the base number, matching the real
// <7> diamond convention on MTA signage; all trains carry their route letter/number.
function trainIcon(status, routeColor, currentStatus, routeId) {
  const movingClass = currentStatus !== VEHICLE_STATUS_STOPPED_AT ? ' in-transit' : '';
  const isExpress = /X$/.test(routeId);
  const shapeClass = isExpress ? ' diamond' : '';
  const label = isExpress ? routeId.slice(0, -1) : routeId;
  const color = routeColor || DEFAULT_ROUTE_COLOR;
  return L.divIcon({
    className: 'train-icon',
    html: `<div class="train-marker${movingClass}${shapeClass}" style="--route-color: ${color}; --status-color: ${STATUS_COLOR[status] || STATUS_COLOR.unknown}; color: ${textColorFor(color)}"><span class="train-label">${esc(label)}</span></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// Trains are drawn offset a few pixels to the RIGHT of their direction of travel
// (right-hand running, as NYC trains actually operate) — uptown and downtown trains
// ride on opposite sides of the single drawn line instead of overlapping. The offset
// is fixed in screen pixels, so the equivalent distance in meters depends on zoom.
const TRAIN_OFFSET_PX = 4;
const NYC_LAT_RAD = (40.75 * Math.PI) / 180;
function trainOffsetMeters() {
  // Web-mercator meters-per-pixel at NYC's latitude for the current zoom.
  return (TRAIN_OFFSET_PX * 156543.03392 * Math.cos(NYC_LAT_RAD)) / 2 ** map.getZoom();
}

// Trains animate on a ~30fps requestAnimationFrame loop, recomputing each position from
// its time-projected segment every frame — genuinely continuous motion instead of the
// old 1s tick smoothed by a CSS transition (which produced a visible once-a-second
// cadence and made markers lag the map during zoom). DOM writes are the expensive part
// with ~700 markers, so each frame gates them hard:
//   - skip markers outside the (padded) viewport, catching them up on a ~1s coarse pass
//   - skip movements under a third of a pixel at the current zoom
// Zoomed out, nearly all motion is sub-pixel and frames cost almost nothing; zoomed in,
// only the handful of visible trains actually move — right where smoothness is seen.
const FRAME_INTERVAL_MS = 33; // ~30fps
const FRAME_MIN_PX = 0.3;
const COS_NYC = Math.cos(NYC_LAT_RAD);
let lastCoarsePassMs = 0;

function updateVehiclePositions(force = false) {
  const now = Date.now();
  const offset = trainOffsetMeters();
  const metersPerPx = (156543.03392 * COS_NYC) / 2 ** map.getZoom();
  const minMoveM2 = (FRAME_MIN_PX * metersPerPx) ** 2;
  const bounds = map.getBounds().pad(0.2);
  // A zero-size container (map not laid out yet, or an embedding that collapses it)
  // degenerates getBounds() to a point that contains nothing — the viewport gate would
  // silently freeze every marker between coarse passes. Skip the gate in that state.
  const mapSize = map.getSize();
  const boundsUsable = mapSize.x > 0 && mapSize.y > 0;
  const coarsePass = force || now - lastCoarsePassMs > 1000;
  if (coarsePass) lastCoarsePassMs = now;

  for (const [tripId, { routeId, segment }] of vehicleSegments) {
    const marker = vehicleMarkers.get(tripId);
    if (!marker) continue;
    const cur = marker.getLatLng();
    if (!coarsePass && boundsUsable && !bounds.contains(cur)) continue;

    const pos = trackIndex.positionAlongSegment(routeId, segment, now, offset);
    const dLat = (pos[0] - cur.lat) * 111320;
    const dLon = (pos[1] - cur.lng) * 111320 * COS_NYC;
    if (!force && dLat * dLat + dLon * dLon < minMoveM2) continue;

    marker.setLatLng(pos);
    // Leaflet doesn't move an already-open popup along with its marker — keep the (at
    // most one) open train popup glued to the train.
    if (marker.isPopupOpen()) marker.getPopup().setLatLng(pos);
  }
}

let lastFrameMs = 0;
function animationLoop(ts) {
  if (ts - lastFrameMs >= FRAME_INTERVAL_MS) {
    lastFrameMs = ts;
    updateVehiclePositions();
  }
  requestAnimationFrame(animationLoop);
}
requestAnimationFrame(animationLoop);

// The pixel-constant right-hand offset shifts with zoom — force a full resync when a
// zoom settles so every marker (including sub-pixel and off-screen ones) lands exactly.
map.on('zoomend', () => updateVehiclePositions(true));
map.on('moveend', () => updateVehiclePositions(true));

// rAF pauses in background tabs/WebViews; force a resync the moment the page is visible
// again so markers don't show stale positions for even a frame longer than needed.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateVehiclePositions(true);
});

// The open popup's ETA countdown only needs coarse updates — once a second, not 30fps.
setInterval(() => {
  for (const [tripId, marker] of vehicleMarkers) {
    if (marker.isPopupOpen()) marker.setPopupContent(renderTrainPopup(tripId));
  }
}, 1000);

async function loadGeometry() {
  const res = await fetch('/api/lines/geometry');
  if (!res.ok) throw new Error(`Geometry API error ${res.status}`);
  const { stations, routes } = await res.json();

  for (const route of routes) {
    trackIndex.addRoute(route, stations);

    // Each distinct branch gets its own polyline — a route with 3 physical branches draws
    // 3 lines instead of forcing everything onto whichever single shape happened to be
    // picked, which previously stranded stations on other branches far off the drawn line.
    // References are kept per route so alert selection can highlight the affected track.
    const lines = [];
    const shapes = [...(route.track.N || []), ...(route.track.S || [])];
    for (const shape of shapes) {
      lines.push(L.polyline(shape, { color: route.color || DEFAULT_ROUTE_COLOR, weight: 3, opacity: 0.6 }).addTo(map));
    }
    routePolylines.set(route.routeId, lines);
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
    marker.stationName = station.name; // read back when rebinding tooltips at the label-zoom threshold

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
  // Zoomed in further still, switch the hover tooltips to always-visible name labels.
  const STATION_VISIBILITY_ZOOM = 12;
  const STATION_LABEL_ZOOM = 14;
  let labelsShown = false;
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

    // A tooltip's permanence can't be toggled in place — rebind when crossing the
    // threshold (only then; rebinding 475 tooltips on every zoomend would churn the DOM).
    const shouldLabel = zoom >= STATION_LABEL_ZOOM;
    if (shouldLabel !== labelsShown) {
      labelsShown = shouldLabel;
      for (const marker of stationMarkers) {
        marker.unbindTooltip();
        marker.bindTooltip(
          marker.stationName,
          shouldLabel
            ? { permanent: true, direction: 'right', offset: [8, 0], className: 'station-label' }
            : { direction: 'top' }
        );
      }
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

    // setIcon replaces the marker's DOM element, which visibly restarts the pulse
    // animation and costs layout work × ~700 markers — only do it when the icon's
    // appearance actually changed, not on every 15s poll.
    const iconKey = `${v.status}|${v.currentStatus}`;
    const existing = vehicleMarkers.get(v.tripId);
    if (existing) {
      if (existing._iconKey !== iconKey) {
        existing.setIcon(trainIcon(v.status, trackIndex.routeColors.get(v.routeId), v.currentStatus, v.routeId));
        existing._iconKey = iconKey;
      }
      // Don't rely solely on the 1s tick to keep existing markers positioned — mobile
      // WebViews commonly throttle/pause JS timers when not the frontmost active view,
      // which would otherwise freeze a marker mid-segment until the timer resumes (then
      // jump). Resyncing here bounds any such freeze to at most one poll interval.
      existing.setLatLng(trackIndex.positionAlongSegment(v.routeId, v.segment, now, trainOffsetMeters()));
      if (existing.isPopupOpen()) existing.setPopupContent(renderTrainPopup(v.tripId));
    } else {
      const tooltip = v.destination ? `${v.routeId} train → ${v.destination}` : `${v.routeId} train`;
      const marker = L.marker(trackIndex.positionAlongSegment(v.routeId, v.segment, now, trainOffsetMeters()), {
        icon: trainIcon(v.status, trackIndex.routeColors.get(v.routeId), v.currentStatus, v.routeId),
      })
        .bindTooltip(tooltip, { direction: 'top' })
        .bindPopup(() => renderTrainPopup(v.tripId), { maxWidth: 300 })
        .addTo(map);
      marker._iconKey = iconKey;
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

// Service alerts: a chip per affected route; clicking one shows that route's alert text
// and highlights the affected track on the map.
const ALERTS_REFRESH_MS = 60000;
let activeAlerts = [];
let selectedAlertRoute = null;

// Express variants share their base route's physical track (7 and 7X, 6 and 6X) — an
// alert for either should light up the same line, not leave a dimmed twin underneath.
function sameTrunk(a, b) {
  return a.replace(/X$/, '') === b.replace(/X$/, '');
}

function applyAlertHighlight() {
  for (const [routeId, lines] of routePolylines) {
    let style;
    if (!selectedAlertRoute) style = { weight: 3, opacity: 0.6 };
    else if (sameTrunk(routeId, selectedAlertRoute)) style = { weight: 6, opacity: 1 };
    else style = { weight: 3, opacity: 0.12 };
    for (const line of lines) line.setStyle(style);
  }
}

function renderAlerts() {
  const bar = document.getElementById('alerts-bar');
  const chips = document.getElementById('alerts-chips');
  const detail = document.getElementById('alerts-detail');

  const routes = [...new Set(activeAlerts.flatMap((a) => a.routeIds))].sort();
  if (!routes.length) {
    bar.hidden = true;
    detail.hidden = true;
    selectedAlertRoute = null;
    applyAlertHighlight(); // clear any leftover track highlight if alerts expired while selected
    return;
  }

  bar.hidden = false;
  chips.innerHTML = routes
    .map(
      (r) =>
        `<button class="alert-chip${r === selectedAlertRoute ? ' selected' : ''}" data-route="${esc(r)}" aria-label="Service alert for ${esc(r)} train" aria-pressed="${r === selectedAlertRoute}">${bulletHtml(r)}</button>`
    )
    .join('');
  for (const btn of chips.querySelectorAll('.alert-chip')) {
    btn.addEventListener('click', () => {
      selectedAlertRoute = selectedAlertRoute === btn.dataset.route ? null : btn.dataset.route;
      renderAlerts();
    });
  }

  if (selectedAlertRoute && routes.includes(selectedAlertRoute)) {
    const items = activeAlerts.filter((a) => a.routeIds.includes(selectedAlertRoute));
    detail.innerHTML = items.map((a) => `<div class="alert-item">${esc(a.header)}</div>`).join('');
    detail.hidden = false;
  } else {
    selectedAlertRoute = null;
    detail.hidden = true;
  }

  applyAlertHighlight();
}

// Clicking anywhere outside the alerts UI (including the map itself) dismisses the
// open alert panel and its track highlight. Must be pointerdown, not click: a chip's
// own click handler re-renders the chip row, so by the time a click event bubbles up
// here its target is detached from the DOM and closest('#alerts-bar') can no longer
// prove the press started inside the bar — every chip click would self-dismiss.
document.addEventListener('pointerdown', (e) => {
  if (selectedAlertRoute && !e.target.closest('#alerts-bar') && !e.target.closest('#alerts-detail')) {
    selectedAlertRoute = null;
    renderAlerts();
  }
});

async function refreshAlerts() {
  try {
    const res = await fetch('/api/alerts');
    if (res.ok) {
      activeAlerts = (await res.json()).alerts;
      renderAlerts();
    }
  } catch {
    // Non-critical overlay — keep showing the last known alerts and retry on schedule.
  }
  setTimeout(refreshAlerts, ALERTS_REFRESH_MS);
}
refreshAlerts();

loadGeometry()
  .then(() => {
    renderAlerts(); // re-render chips now that real route colors are loaded
    return refresh();
  })
  .catch((err) => {
    document.getElementById('status-text').textContent = `Error loading map: ${err.message}`;
  });
