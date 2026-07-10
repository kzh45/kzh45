# 7 Train Live Arrivals

Live NYC subway 7 train arrival predictions, decoded straight from MTA's GTFS-realtime feed.

## Stack

- **Backend:** Node + Express, decodes MTA's `nyct%2Fgtfs` protobuf feed with `gtfs-realtime-bindings` and filters it down to route `7` ([mta.js](mta.js), [server.js](server.js))
- **Frontend:** static HTML/CSS/JS that polls the backend every 20s and renders a per-station arrivals board, with a loading indicator and error retry (auto backoff + manual button) ([public/](public))

No MTA API key is required — the real-time feed endpoint is public.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

To just print live 7 train data to the terminal instead of running the server:

```bash
npm run fetch:7train
```

## API

`GET /api/7train` returns JSON:

```json
{
  "fetchedAt": 1234567890000,
  "trips": [{ "tripId": "...", "routeId": "7", "stopTimeUpdates": [{ "stopId": "725S", "arrival": 1234567890000, "departure": 1234567900000 }] }],
  "vehicles": [{ "tripId": "...", "stopId": "725S", "currentStatus": 1 }]
}
```

Stop IDs end in `N` (Flushing-bound) or `S` (Manhattan-bound).
