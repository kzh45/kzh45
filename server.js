const express = require('express');
const path = require('path');
const { fetchRouteUpdates } = require('./mta');

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

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
