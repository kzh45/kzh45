# Handoff: Headway (NYC subway live tracker)

Read this before touching the code. It covers what's built, why the non-obvious parts
work the way they do, and what's left. Written 2026-07-10 after ~15 commits of work.

## What this is

A live map of the entire NYC subway system (minus Staten Island Railway), decoded
straight from MTA's public GTFS-realtime feeds — no API key required. Three surfaces
share one backend:

1. **Web live map** (`public/index.html`, served at `/`) — full system, interactive
   (pan/zoom/click). The landing page; `public/map.html` is a redirect stub for old links.
2. **Web arrivals board** (`public/board.html`) — per-station countdowns for any route,
   with a route picker (originally the 7-train-only MVP).
3. **Lobby kiosk** (`public/kiosk.html`) — full system, locked full-screen view for an
   unattended display (originally scoped for a building lobby screen).
4. **Mobile app** (`mobile/`, Expo/React Native) — 7-train arrivals list, plus a "Map"
   tab that embeds `map.html` in a WebView (a native `react-native-maps` version was
   built and explicitly abandoned — see "Decisions" below).

Nothing is deployed yet. Everything runs locally (`npm start` on port 3000 for the
backend; Expo Metro for mobile). Deployment to Railway was scoped but never done —
see "What's left."

## Architecture

```
mta.js              Fetches/decodes MTA's 7 separate GTFS-RT protobuf feeds, computes
                     delay/status/interpolated-position per vehicle. Caches both the raw
                     feed and the full computed result per route (15s TTL).
gtfs-static.js       Downloads/parses MTA's static GTFS schedule (stops/trips/stop_times/
                     shapes/routes). Matches real-time trips to their scheduled
                     counterpart for delay computation and stop-sequence lookups.
                     Per-route in-memory cache, keyed and never expires within a process
                     lifetime (see "Known limitations").
server.js            Express app. Static file serving + the API routes below.

public/
  index.html/map.js/map.css     Interactive full-system map (the landing page)
  board.html/app.js/style.css   Arrivals board with route picker
  kiosk.html/kiosk.js/kiosk.css Locked-view lobby display
  map-core.js                   SHARED geometry/interpolation engine used by both
                                 map.js and kiosk.js — track-snapping, branch matching,
                                 position interpolation. Fix things here once, both
                                 pages get it.
  connect.html                  Dev convenience: a real <a href="exp://..."> link,
                                 because Safari can't navigate custom schemes typed
                                 directly into the address bar (see "Known limitations").

mobile/
  App.tsx                       List/Map toggle, list view is a port of public logic
  components/WebMapView.tsx     WebView wrapping the web map (/) — this IS the mobile map
  lib/mta.ts                    7-train-specific fetch/grouping logic + getApiBaseUrl()
                                 (derives the backend's LAN IP from Expo's dev server URI)

fetch-route.js, poc-live-status.js   Terminal debug scripts (take a route ID arg), not part of the served app
```

### API endpoints

- `GET /api/lines?routes=1,2,A,...` — all routes (default: `ALL_ROUTE_IDS`, everything
  except SIR). Returns `{ fetchedAt, vehicles }` by default — the trips array is ~85% of
  the payload and the map/kiosk pollers never read it; `?include=trips` adds it back.
  Vehicles carry `destination` (headsign from the matched static trip).
- `GET /api/lines/geometry?routes=...` — returns `{ stations, routes }`, where each route
  has `{ routeId, color, track: {N,S}, stationIds }`. `stationIds` exists specifically so
  clients can filter the global station list down before doing per-station geometry
  matching (see the stutter fix below — this field is load-bearing for performance).
  Served with Cache-Control max-age=3600; ETag revalidation returns 304.
- `GET /api/stops/:stopId/arrivals` — next ~12 arrivals at one station (base stop ID, no
  N/S suffix) across all routes/directions, from the same 15s-cached computed results.
- `GET /api/routes/:routeId/stations` — a route's stations in line order, derived by
  topologically merging every scheduled trip's stop sequence (branch-aware; the trunk
  order comes from the longest sequences, branch stations follow their junction).
- `GET /api/alerts` — currently-active service alerts (route IDs + header text) from
  MTA's `camsys%2Fsubway-alerts` GTFS-rt feed; planned-work notices with future active
  periods are filtered out.
- `GET /healthz` — liveness probe.
- The legacy 7-train-only endpoints (`/api/7train`, `/api/7train/geometry`) were removed
  when the boards were generalized — nothing consumed them anymore.

Everything is gzipped (compression middleware). Measured effect: /api/lines poll
1.9MB → ~16KB; geometry 2.1MB → ~180KB (then 0 on ETag revalidation).

## Decisions worth knowing before you change anything

These took real investigation to figure out. If you're refactoring and something here
seems weird, it's probably intentional — check before "fixing" it.

**No API key needed.** MTA dropped the requirement (~2021-ish per `nyct-gtfs` changelog).
Confirmed empirically at the start of this project — don't add key handling back without
re-verifying it's actually needed again.

**Feed layout (7 separate feeds, not 1):**
```js
// mta.js FEED_GROUPS
'nyct%2Fgtfs':      1,2,3,4,5,6,6X,7,7X,GS   // numbered lines + express variants + shuttle
'nyct%2Fgtfs-ace':  A,C,E,H
'nyct%2Fgtfs-bdfm': B,D,F,M,FS                // Franklin Ave Shuttle is HERE, not ACE
'nyct%2Fgtfs-g':    G
'nyct%2Fgtfs-jz':   J,Z
'nyct%2Fgtfs-l':    L
'nyct%2Fgtfs-nqrw': N,Q,R,W
```
SIR (Staten Island Railway) is deliberately excluded — its live feed's route ID ("SS")
has zero static-schedule coverage, and it's geographically disconnected from the rest of
the system anyway. This was a judgment call, not a limitation; revisit if the user wants
it included.

**No GPS in the feed, at all.** NYCT publishes trip updates (predicted stop times) and a
coarse vehicle status (`STOPPED_AT` / `IN_TRANSIT_TO` / `INCOMING_AT` + current stop ID),
but never lat/lon for a moving train. All train positions on the map are **interpolated**
between the previous and next station along the real track geometry, using timing derived
from the static schedule (see next point). This is inherent to the data source, not
something we can "fix" by finding a better field.

**Trip-ID matching (the trickiest part of this codebase).** To get delay data and a
train's scheduled stop sequence, real-time trips must be matched to their static-schedule
counterpart. NYCT trip IDs embed a shared key: a 6-digit origin-time code (minutes × 100,
e.g. `036400` = 364 min = 6:04am) plus route+direction, e.g. `014000_7..S`. Static trip
IDs embed the identical substring with junk around it:
`L0S1-7-1064-S300_014000_7..S97R`. `gtfs-static.js`'s `TRIP_KEY_RE` extracts this
substring from either side. Quirks found the hard way:
- Express variants (7X, 6X) encode the *base* route letter internally even though their
  `route_id` column says "7X" — `normalizeTripKey()` strips a trailing X before matching.
- Shuttles (GS, FS, SI) use a single dot before the direction letter (`GS.S04R`) instead
  of the usual double dot (`7..S97R`) — the regex accepts either.
- Z trains encode internally as "J" in *both* real-time and static IDs — this needed no
  special-casing, just don't "fix" it if you notice it.
- Real trips don't always land on an exact scheduled code (real-world drift) — there's a
  nearest-code fallback within `FALLBACK_CODE_TOLERANCE` = 800 units (8 min).

**Branch-aware track geometry.** Branching lines (2, 5, A, E, F, N, Q, R, W...) have
multiple genuinely distinct physical paths per direction. Picking just one "representative"
shape per route+direction (the original approach) stranded stations on other branches up
to 5.6km from the drawn line. Fixed by keeping every genuinely distinct branch — shapes
are clustered by sampling `SHAPE_DEDUP_SAMPLE_COUNT` = 8 points along their length and
treating shapes within `SHAPE_DEDUP_TOLERANCE_METERS` = 300m at every sample as the same
physical path (keeping the most detailed one). `map-core.js`'s `bestShapeMatchForStation`
then finds which *specific* branch a station sits on, and `getSubPath` only builds a path
between two stations if they matched the *same* branch — if not, falls back to a straight
line rather than guessing how branches connect.

**Colors are hardcoded, not from the feed.** MTA's own `routes.txt` route_color values
are a muted internal palette, not the vivid colors on the actual subway map/signage that
everyone recognizes. `CANONICAL_ROUTE_COLORS` in `gtfs-static.js` overrides them with the
standard public palette.

**Caching, two layers:**
- `mta.js`: raw feed bytes cached per feed URL (`CACHE_TTL_MS` = 15s), AND the full
  computed result (trips/vehicles/delay/segments) cached per route, also 15s — this
  second layer matters, it's the difference between ~170ms and redoing hundreds of
  schedule lookups on every single request from every poller.
- `gtfs-static.js`: parsed static schedule cached per route, refreshed
  stale-while-revalidate once older than `MAX_AGE_MS` (7 days) — the old parse keeps
  serving while a background re-parse (which also triggers the on-disk zip re-download)
  swaps in, so live requests never stall on the ~7s parse.
- Server pre-warms all routes' static schedules at startup (`server.js`, fire-and-forget
  after `app.listen`) so the first real visitor doesn't eat a ~7.6s cold-parse penalty.

**Native mobile map was built and deliberately abandoned.** A full `react-native-maps`
implementation existed (ported `map-core.js` to TypeScript, custom Marker/Polyline
rendering) — user A/B tested it against a WebView wrapping `map.html` and preferred the
WebView (faster load, and avoids the question of whether native markers keep up
animating 700+ trains every second across the RN bridge). The native version was fully
removed (component, ported TS module, `react-native-maps` dependency) rather than kept
around unused. Don't resurrect it without discussing — it was a real, reasoned decision.

## Known limitations / things not done

- **Not deployed anywhere.** Runs on localhost only. Railway was scoped twice and the
  user explicitly chose to defer it ("lets skip the deployment to railway for now") —
  don't push it unprompted, but it remains the prerequisite for the lobby-kiosk vision,
  which can't point at localhost. The repo is deploy-ready: `engines.node` pin, `PORT`
  env, gzip, `/healthz`, startup pre-warm, stale-cache refresh.
- **Rockaway Park Shuttle (H) has a ~33% trip-match rate.** Traced to a genuine gap in
  MTA's own static schedule (a stop referenced in real-time that no static trip covers).
  Not a bug in this codebase; a known upstream data quality issue for one low-ridership
  shuttle. Every other route is 95-100%.
- **Tests cover only the trip-matching core.** `npm test` runs 13 smoke tests over the
  trip-ID quirk logic (test/trip-matching.test.js) — nothing else is under test.
- **Some features never got a live visual check.** Browser automation tools were flaky
  through late sessions; the kiosk alert rotation and the right-hand-running train offset
  were verified at the API/logic level only. Worth opening / and /kiosk.html and looking
  around when picking this up.

## Recently fixed bugs (context for why certain code looks the way it does)

Roughly chronological, most recent first — useful if something regresses and you're
trying to figure out if it's a repeat of a known issue:

- Map-open bandwidth: no gzip anywhere, 1.9MB polls carrying a trips array the map never
  read, 2.1MB uncached geometry — fixed with compression middleware, vehicles-only
  default on /api/lines, and Cache-Control/ETag on geometry.
- Existing map markers only repositioned via a 1s `setInterval` tick; mobile WebViews
  throttle/pause such timers when backgrounded, freezing a marker mid-segment until the
  timer resumed and jumped. Fixed by resyncing position on every 15s poll too (not just
  the icon), plus an immediate resync on `visibilitychange`.
- Map-open stutter: client matched every route's shapes against all 475 system-wide
  stations instead of just the ~20-90 it actually serves (1.28s → 170ms fix), plus backend
  cold-start on first request after restart (7.6s → 59ms via startup pre-warm).
- Train markers floating off-position during touch pinch-zoom on mobile — the
  `.leaflet-zoom-anim`-class-based fix (works for button/programmatic zoom) doesn't
  reliably cover touch pinch; added explicit `zoomstart`/`zoomend` listeners.
- Off-track stations on branching lines (see "Branch-aware track geometry" above).
- Legibility: route-color fill and status-ring color used the same red/green hues on
  routes whose own color is red or green (1/2/3, 4/5/6) — a delayed 1-train and an
  on-time 4-train both looked like flat blobs. Fixed with a dark separator ring (box-shadow
  layering) so the status ring stays visually distinct regardless of route hue.

## How to run it

```bash
# Backend (from repo root)
npm install
npm start                     # http://localhost:3000

# Debug scripts
npm run fetch:route -- A      # one-shot terminal dump for a route (default 7)
npm run poc:live-status       # polls every 30s, color-coded on-time/delayed in terminal

# Mobile (from mobile/)
npm install
npx expo start                # then scan QR / open in Expo Go
```

Mobile connects to the backend via LAN IP (see `mobile/lib/mta.ts` `getApiBaseUrl()`),
derived automatically from Expo's dev server URI — phone and dev machine must be on the
same wifi. If Expo Go's "Enter URL manually" is finicky, `public/connect.html` has a real
tappable `exp://` link (Safari can't navigate custom schemes typed directly).

Expo Go's App Store build lags the latest SDK by MTA/Apple review delays — if you hit
"Project is incompatible with this version of Expo Go," downgrade the mobile project's
SDK to match (`npm install expo@^54.0.0 && npx expo install --fix` was the fix when SDK
57 was too new; check what's current when picking this back up).

## Collaboration notes (from this session)

- User explicitly asked for honest pushback over default compliance — flag oversized or
  risky ideas and propose alternatives rather than just executing as literally stated.
  (This is saved in this Claude Code installation's persistent memory, not just this repo.)
- Prefers committing in logically separate commits (not one giant commit per session) —
  see the git log for the granularity that was well-received.
- Only commit/push when explicitly asked; don't do it proactively.
- Wants things actually verified (live API calls, real device testing), not just "should
  work" — several bugs in this project were only caught because of that insistence.
