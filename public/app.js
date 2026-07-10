// Station names for the 7 line, keyed by the numeric GTFS stop ID (direction suffix N/S added at lookup time).
const STATION_NAMES = {
  701: 'Flushing–Main St',
  702: 'Mets–Willets Point',
  705: '111 St',
  706: '103 St–Corona Plaza',
  707: 'Junction Blvd',
  708: '90 St–Elmhurst Av',
  709: '82 St–Jackson Hts',
  710: '74 St–Broadway',
  711: '69 St',
  712: '61 St–Woodside',
  713: '52 St',
  714: '46 St–Bliss St',
  715: '40 St–Lowery St',
  716: '33 St–Rawson St',
  718: 'Queensboro Plaza',
  719: 'Court Sq–23rd St',
  720: 'Hunters Point Av',
  721: 'Vernon Blvd–Jackson Av',
  723: 'Grand Central–42nd St',
  724: '5th Av',
  725: 'Times Sq–42nd St',
  726: '34th St–Hudson Yards',
};

// Order stations are listed in, from Flushing to Hudson Yards.
const STATION_ORDER = Object.keys(STATION_NAMES).map(Number);

const REFRESH_MS = 20000;
const MAX_RETRY_MS = 60000;
const MAX_ARRIVALS_SHOWN = 3;

function stationName(stopId) {
  const numeric = parseInt(stopId, 10);
  return STATION_NAMES[numeric] || stopId;
}

function minutesUntil(timestampMs) {
  const diffMs = timestampMs - Date.now();
  return Math.max(0, Math.round(diffMs / 60000));
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

  const stationsWithData = STATION_ORDER.filter(
    (id) => groups[id] && groups[id][direction] && groups[id][direction].length
  );

  if (!stationsWithData.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No upcoming trains found.';
    listEl.appendChild(li);
    return;
  }

  for (const stationId of stationsWithData) {
    const times = groups[stationId][direction].slice(0, MAX_ARRIVALS_SHOWN);

    const li = document.createElement('li');
    li.className = 'station';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'station-name';
    nameSpan.textContent = stationName(stationId);

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

    const groups = groupByStationAndDirection(data.trips);
    renderBoard(document.getElementById('board-N'), groups, 'N');
    renderBoard(document.getElementById('board-S'), groups, 'S');

    consecutiveErrors = 0;
    statusEl.classList.remove('error');
    statusText.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
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

refresh();
