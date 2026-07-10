const express = require('express');
const path = require('path');
const { fetchRouteUpdates, fetchLinesUpdates, ALL_ROUTE_IDS } = require('./mta');
const { getGeometry, getMultiRouteGeometry } = require('./gtfs-static');

const app = express();
const PORT = process.env.PORT || 3000;

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
    const routes = req.query.routes ? req.query.routes.split(',') : ALL_ROUTE_IDS;
    const data = await fetchLinesUpdates(routes);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/lines/geometry', async (req, res) => {
  try {
    const routes = req.query.routes ? req.query.routes.split(',') : ALL_ROUTE_IDS;
    const data = await getMultiRouteGeometry(routes);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
