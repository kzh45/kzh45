const express = require('express');
const path = require('path');
const compression = require('compression');
const { fetchRouteUpdates, fetchLinesUpdates, ALL_ROUTE_IDS } = require('./mta');
const { getGeometry, getMultiRouteGeometry } = require('./gtfs-static');

const app = express();
const PORT = process.env.PORT || 3000;

// The API payloads are large, repetitive JSON (2.1MB geometry, vehicle updates every
// 15s from every open client) — gzip cuts them ~8-10x, which is the difference between
// snappy and sluggish on cellular or weak wifi.
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/api/7train', async (req, res) => {
  try {
    const data = await fetchRouteUpdates('7');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/7train/geometry', async (req, res) => {
  try {
    const data = await getGeometry('7');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/lines', async (req, res) => {
  try {
    const routes = req.query.routes ? req.query.routes.split(',') : ALL_ROUTE_IDS;
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
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/lines/geometry', async (req, res) => {
  try {
    const routes = req.query.routes ? req.query.routes.split(',') : ALL_ROUTE_IDS;
    const data = await getMultiRouteGeometry(routes);

    // Track geometry only changes when MTA republishes the static schedule (roughly
    // monthly; we re-download weekly) — let clients cache it for an hour and then
    // revalidate via the ETag Express already generates, instead of re-downloading
    // ~2MB on every page open.
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);

  // Parsing all routes' static schedules takes ~7s the first time (cold in-memory cache) —
  // pay that cost once at startup instead of making the first real visitor wait for it.
  getMultiRouteGeometry(ALL_ROUTE_IDS).catch((err) => {
    console.error('Static schedule pre-warm failed (will retry lazily on first request):', err.message);
  });
});
