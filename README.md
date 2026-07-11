# NYC Subway Live Tracker

A live map of the entire NYC subway system — every train, moving in real time along its
actual track, colored by line, ringed green/red for on-time/delayed — decoded straight
from MTA's public GTFS-realtime feeds. No API key required.

## Surfaces

All served by one Node/Express backend on port 3000:

| Surface | URL | What it is |
|---|---|---|
| Live map | `/map.html` | Interactive full-system map: pan/zoom, tap a train for destination + delay + next stop, tap a station for upcoming arrivals, service-alert chips |
| Lobby kiosk | `/kiosk.html` | Locked full-screen view for an unattended display, with rotating service alerts |
| Arrivals board | `/` | The original 7-train list view (per-station countdown clocks) |
| Mobile app | `mobile/` | Expo/React Native — arrivals list plus the live map in a WebView |

Trains move continuously between stations. NYCT publishes no GPS for subway trains —
positions are interpolated along real track geometry from predicted stop times, matched
against MTA's static schedule (which is also where delay status and destinations come
from).

## Run it

```bash
npm install
npm start          # http://localhost:3000 — first start downloads/parses MTA's
                   # static schedule (~10s pre-warm, logged to console)
npm test           # smoke tests for the trip-matching logic
```

Terminal debug scripts: `npm run fetch:7train` (one-shot dump), `npm run poc:live-status`
(polls every 30s, color-coded delays).

### Mobile

```bash
cd mobile && npm install && npx expo start
```

Open in Expo Go on a phone on the same wifi. The app derives the backend's LAN address
from Expo's dev-server URI automatically. If entering the URL manually is finicky,
`http://<lan-ip>:3000/connect.html` has a tappable `exp://` link.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/lines` | Live vehicles for all routes: interpolated position segment, delay status, destination. `?routes=1,7,A` filters; `?include=trips` adds full per-stop predictions (~10x larger) |
| `GET /api/lines/geometry` | Stations + per-branch track polylines + route colors (cacheable, changes ~weekly) |
| `GET /api/stops/:stopId/arrivals` | Next arrivals at one station across all routes/directions |
| `GET /api/alerts` | Currently-active service alerts per route |
| `GET /api/7train`, `/api/7train/geometry` | Legacy single-route endpoints used by the list views |
| `GET /healthz` | Liveness probe |

Stop IDs are GTFS: a base ID (`723` = Grand Central on the 7) plus `N`/`S` platform
suffix in trip data.

## Coverage

All routes across NYCT's 7 GTFS-rt feeds: 1-7 (+6X/7X express), A/C/E/H, B/D/F/M/FS, G,
J/Z, L, N/Q/R/W, GS. Staten Island Railway is deliberately excluded (disconnected from
the network; its live feed has no static-schedule coverage). Schedule-match rates are
95-100% per route except the Rockaway Park Shuttle (~33% — a gap in MTA's own published
schedule).

## Architecture

```
mta.js          GTFS-rt fetch/decode, delay computation, position interpolation,
                per-station arrivals, service alerts (15s caches, single-flight)
gtfs-static.js  Static schedule download/parse (weekly refresh), real-time↔static trip
                matching, branch-aware track geometry, station/color data
server.js       Express: static files + API routes, schedule pre-warm at startup
public/map-core.js  Shared client geometry engine (track snapping, branch matching,
                    interpolation) used by both map.js and kiosk.js
```

For the non-obvious design decisions (trip-ID matching quirks, branch geometry
deduplication, caching layers, what was tried and abandoned), read **HANDOFF.md** first.
