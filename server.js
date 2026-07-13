const express = require('express');
const path = require('path');
const compression = require('compression');
const { fetchLinesUpdates, getStopArrivals, fetchServiceAlerts, getStats, ALL_ROUTE_IDS } = require('./mta');
const { getMultiRouteGeometry, getRouteStations, parseRouteColor } = require('./gtfs-static');

const app = express();
const PORT = process.env.PORT || 3000;
const KNOWN_ROUTES = new Set(ALL_ROUTE_IDS);

// Parses a ?routes= param, returning the requested routes or throwing a 400-tagged error
// on any unknown id — so a typo gets a clear "unknown route" instead of a confusing 502
// from a downstream "Unknown routeId" throw.
function parseRoutesParam(routesParam) {
  if (!routesParam) return ALL_ROUTE_IDS;
  const requested = routesParam.split(',');
  const unknown = requested.filter((r) => !KNOWN_ROUTES.has(r));
  if (unknown.length) {
    const err = new Error(`Unknown route(s): ${unknown.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  return requested;
}

function sendError(res, err) {
  res.status(err.statusCode || 502).json({ error: err.message });
}

// The API payloads are large, repetitive JSON (2.1MB geometry, vehicle updates every
// 15s from every open client) — gzip cuts them ~8-10x, which is the difference between
// snappy and sluggish on cellular or weak wifi.
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  const stats = getStats();
  // Degraded once live data is stale beyond a few poll cycles — a monitor (or a glance
  // during setup) can tell a stuck kiosk from a healthy one.
  const stale = stats.lastFeedSuccessAgeSeconds != null && stats.lastFeedSuccessAgeSeconds > 90;
  res.json({
    ok: !stale,
    uptimeSeconds: Math.round(process.uptime()),
    lastFeedSuccessAgeSeconds: stats.lastFeedSuccessAgeSeconds,
    feedFetches: stats.feedFetches,
    feedErrors: stats.feedErrors,
  });
});

// Tiny route metadata (id + color) so the arrivals board can style its picker chips
// without fetching the ~180KB geometry payload. Colors are canonical and static.
app.get('/api/routes', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(ALL_ROUTE_IDS.map((routeId) => ({ routeId, color: parseRouteColor(routeId) })));
});

app.get('/api/lines', async (req, res) => {
  try {
    const routes = parseRoutesParam(req.query.routes);
    const data = await fetchLinesUpdates(routes);

    // The trips array is ~85% of the payload and the map/kiosk pollers only read
    // vehicles — don't ship ~1.6MB of stop-time updates every 15s to clients that
    // never look at them. Pass ?include=trips to get the full response.
    if (req.query.include === 'trips') {
      res.json(data);
    } else {
      res.json({ fetchedAt: data.fetchedAt, vehicles: data.vehicles });
    }
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/routes/:routeId/stations', async (req, res) => {
  try {
    if (!KNOWN_ROUTES.has(req.params.routeId)) {
      return res.status(400).json({ error: `Unknown route: ${req.params.routeId}` });
    }
    const data = await getRouteStations(req.params.routeId);
    // Station order only changes when the static schedule does (~monthly) — same
    // caching treatment as geometry.
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const data = await fetchServiceAlerts();
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/stops/:stopId/arrivals', async (req, res) => {
  try {
    const data = await getStopArrivals(req.params.stopId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/lines/geometry', async (req, res) => {
  try {
    const routes = parseRoutesParam(req.query.routes);
    const data = await getMultiRouteGeometry(routes);

    // Track geometry only changes when MTA republishes the static schedule (roughly
    // monthly; we re-download weekly) — let clients cache it for an hour and then
    // revalidate via the ETag Express already generates, instead of re-downloading
    // ~2MB on every page open.
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`Headway server listening on port ${PORT}`);

  // Parsing all routes' static schedules takes ~7s the first time (cold in-memory cache) —
  // pay that cost once at startup instead of making the first real visitor wait for it.
  // On an ephemeral-filesystem host this also downloads MTA's static GTFS zip on each cold
  // boot; failure here is non-fatal (lazy retry on first request).
  getMultiRouteGeometry(ALL_ROUTE_IDS).catch((err) => {
    console.error('Static schedule pre-warm failed (will retry lazily on first request):', err.message);
  });
});
