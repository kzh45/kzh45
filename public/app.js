const REFRESH_MS = 20000;
const MAX_RETRY_MS = 60000;
const MAX_ARRIVALS_SHOWN = 3;

// Boards a rider can pick. Express variants aren't separate entries — picking the 6 or 7
// folds their diamond trains into the same board, since a rider on the platform cares
// about both.
const PICKER_ROUTES = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'GS', 'FS', 'H'];
const EXPRESS_COMPANIONS = { 6: '6X', 7: '7X' };

let currentRoute = localStorage.getItem('boardRoute') || '7';
if (!PICKER_ROUTES.includes(currentRoute)) currentRoute = '7';

let stationOrder = []; // [{ stopId, name }] in line order (S-direction start -> end)
let stationNameById = new Map();
const routeColors = new Map(); // routeId -> "#rrggbb", from the geometry endpoint

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function textColorFor(color) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#0b0f14' : '#fff';
}

function minutesUntil(timestampMs) {
  const diffMs = timestampMs - Date.now();
  return Math.max(0, Math.round(diffMs / 60000));
}

function routesParam() {
  const companion = EXPRESS_COMPANIONS[currentRoute];
  return companion ? `${currentRoute},${companion}` : currentRoute;
}

function groupByStationAndDirection(trips) {
  // stationId -> direction ('N' | 'S') -> [timestampMs, ...]
  const groups = {};

  for (const trip of trips) {
    for (const stu of trip.stopTimeUpdates) {
      const time = stu.arrival || stu.departure;
      if (!time || time < Date.now() - 30000) continue; // skip stale/past predictions

      const direction = stu.stopId.slice(-1); // 'N' or 'S'
      const stationId = stu.stopId.slice(0, -1);

      if (!groups[stationId]) groups[stationId] = { N: [], S: [] };
      if (groups[stationId][direction]) groups[stationId][direction].push(time);
    }
  }

  for (const stationId in groups) {
    groups[stationId].N.sort((a, b) => a - b);
    groups[stationId].S.sort((a, b) => a - b);
  }

  return groups;
}

function renderBoard(listEl, groups, direction) {
  listEl.innerHTML = '';

  const stationsWithData = stationOrder.filter(
    (s) => groups[s.stopId] && groups[s.stopId][direction] && groups[s.stopId][direction].length
  );

  if (!stationsWithData.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No upcoming trains found.';
    listEl.appendChild(li);
    return;
  }

  for (const station of stationsWithData) {
    const times = groups[station.stopId][direction].slice(0, MAX_ARRIVALS_SHOWN);

    const li = document.createElement('li');
    li.className = 'station';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'station-name';
    nameSpan.textContent = station.name;

    const arrivalsSpan = document.createElement('span');
    arrivalsSpan.className = 'arrivals';
    arrivalsSpan.innerHTML = times
      .map((t, i) => `<span class="${i === 0 ? 'next' : ''}">${minutesUntil(t)} min</span>`)
      .join('');

    li.appendChild(nameSpan);
    li.appendChild(arrivalsSpan);
    listEl.appendChild(li);
  }
}

function renderPicker() {
  const picker = document.getElementById('route-picker');
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Choose a route');
  picker.innerHTML = PICKER_ROUTES.map((r) => {
    const color = routeColors.get(r) || '#8b98a5';
    const selected = r === currentRoute ? ' selected' : '';
    return `<button class="route-chip${selected}" data-route="${esc(r)}" aria-label="${esc(r)} train" aria-pressed="${r === currentRoute}" style="background:${color};color:${textColorFor(color)}">${esc(r)}</button>`;
  }).join('');
  for (const btn of picker.querySelectorAll('.route-chip')) {
    btn.addEventListener('click', () => selectRoute(btn.dataset.route));
  }
}

function renderTitle() {
  const bullet = document.getElementById('route-bullet');
  const color = routeColors.get(currentRoute) || '#b933ad';
  bullet.textContent = currentRoute;
  bullet.style.background = color;
  bullet.style.color = textColorFor(color);
}

async function selectRoute(routeId) {
  currentRoute = routeId;
  localStorage.setItem('boardRoute', routeId);
  renderPicker();
  renderTitle();

  document.getElementById('board-N').innerHTML = '';
  document.getElementById('board-S').innerHTML = '';
  document.getElementById('status-text').textContent = 'Loading…';

  try {
    const res = await fetch(`/api/routes/${routeId}/stations`);
    if (!res.ok) throw new Error(`Stations API error ${res.status}`);
    const { stations } = await res.json();
    if (routeId !== currentRoute) return; // user picked another route mid-fetch

    stationOrder = stations;
    stationNameById = new Map(stations.map((s) => [s.stopId, s.name]));

    // The S-direction sequence starts at the line's northern terminal and ends at its
    // southern one — so each board's header names the terminal it's heading toward.
    document.getElementById('dir-N-label').textContent = stations.length ? `To ${stations[0].name}` : 'Northbound';
    document.getElementById('dir-S-label').textContent = stations.length ? `To ${stations[stations.length - 1].name}` : 'Southbound';
  } catch (err) {
    document.getElementById('status-text').textContent = `Error loading stations: ${err.message}`;
    return;
  }

  refresh();
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

  const routeAtFetch = currentRoute;
  try {
    const res = await fetch(`/api/lines?routes=${routesParam()}&include=trips`);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    if (routeAtFetch !== currentRoute) return; // superseded by a route switch

    const groups = groupByStationAndDirection(data.trips);
    renderBoard(document.getElementById('board-N'), groups, 'N');
    renderBoard(document.getElementById('board-S'), groups, 'S');

    consecutiveErrors = 0;
    statusEl.classList.remove('error');
    statusText.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    spinner.hidden = true;

    pendingRetryId = setTimeout(refresh, REFRESH_MS);
  } catch (err) {
    if (routeAtFetch !== currentRoute) return;
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

(async () => {
  try {
    // ~1KB of {routeId,color} — the board only needs chip colors, not the ~180KB of
    // station/track geometry the map loads.
    const res = await fetch('/api/routes');
    if (res.ok) {
      const routes = await res.json();
      for (const r of routes) if (r.color) routeColors.set(r.routeId, r.color);
    }
  } catch {
    // Picker falls back to gray chips; boards still work.
  }
  renderPicker();
  renderTitle();
  selectRoute(currentRoute);
})();
