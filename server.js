const express = require('express');
const path = require('path');
const { fetchRouteUpdates, fetchLinesUpdates } = require('./mta');
const { getGeometry, getMultiRouteGeometry } = require('./gtfs-static');

const app = express();
const PORT = process.env.PORT || 3000;

// The routes carried by MTA's bare "gtfs" feed (numbered lines + their express
// variants + the 42nd St Shuttle) — everything reachable with no extra feed fetch.
const NUMBERED_LINES = ['1', '2', '3', '4', '5', '6', '6X', '7', '7X', 'GS'];

app.use(express.static(path.join(__dirname, 'public')));

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
    const routes = req.query.routes ? req.query.routes.split(',') : NUMBERED_LINES;
    const data = await fetchLinesUpdates(routes);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/lines/geometry', async (req, res) => {
  try {
    const routes = req.query.routes ? req.query.routes.split(',') : NUMBERED_LINES;
    const data = await getMultiRouteGeometry(routes);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
