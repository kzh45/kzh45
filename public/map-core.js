// Shared geometry/interpolation engine used by both map.js (interactive) and kiosk.js
// (lobby display). Keeping this in one place means correctness fixes (like snapping
// trains to the right physical branch on a forking line) apply to both automatically.

const STATUS_COLOR = {
  'on-time': '#2ecc71',
  delayed: '#e0333c',
  unknown: '#8b98a5',
};
const DEFAULT_ROUTE_COLOR = '#b933ad';
const VEHICLE_STATUS_STOPPED_AT = 1;

function metersPerDegree(lat) {
  // Cheap equirectangular approximation — plenty accurate at NYC's scale/latitude.
  return { lat: 111320, lon: 111320 * Math.cos((lat * Math.PI) / 180) };
}

function distanceMeters([lat1, lon1], [lat2, lon2]) {
  const { lat: mLat, lon: mLon } = metersPerDegree((lat1 + lat2) / 2);
  const dy = (lat2 - lat1) * mLat;
  const dx = (lon2 - lon1) * mLon;
  return Math.sqrt(dx * dx + dy * dy);
}

function nearestPointIndex(track, lat, lon) {
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < track.length; i++) {
    const d = distanceMeters(track[i], [lat, lon]);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return { index: bestIndex, dist: bestDist };
}

// Branching lines have multiple distinct physical paths per direction — find which
// specific shape a station actually sits on, not just a point index into one assumed line.
function bestShapeMatchForStation(shapes, lat, lon) {
  let best = null;
  for (let shapeIdx = 0; shapeIdx < shapes.length; shapeIdx++) {
    const { index, dist } = nearestPointIndex(shapes[shapeIdx], lat, lon);
    if (!best || dist < best.dist) best = { shapeIdx, pointIdx: index, dist };
  }
  return best;
}

function pointAtDistance(subPath, targetDist) {
  const { points, cumDist, total } = subPath;
  if (total === 0) return points[0];
  const clamped = Math.min(total, Math.max(0, targetDist));

  for (let i = 1; i < cumDist.length; i++) {
    if (cumDist[i] >= clamped) {
      const segLen = cumDist[i] - cumDist[i - 1];
      const segFraction = segLen > 0 ? (clamped - cumDist[i - 1]) / segLen : 0;
      const [lat1, lon1] = points[i - 1];
      const [lat2, lon2] = points[i];
      return [lat1 + (lat2 - lat1) * segFraction, lon1 + (lon2 - lon1) * segFraction];
    }
  }
  return points[points.length - 1];
}

// Encapsulates the route/track/station lookups needed to place a train's position along
// the real (curved, branch-correct) track between two stations.
function createTrackIndex() {
  const trackByRoute = new Map(); // routeId -> { N: [[[lat,lon],...],...], S: [...] } (arrays of branch polylines)
  const stationIndexByRoute = new Map(); // routeId -> { N: Map(stopId -> {shapeIdx,pointIdx,dist}), S: Map(...) }
  const routeColors = new Map(); // routeId -> "#rrggbb"
  const subPathCache = new Map(); // "routeId|direction|fromStopId|toStopId" -> subPath | null

  function addRoute(route, stations) {
    routeColors.set(route.routeId, route.color || DEFAULT_ROUTE_COLOR);

    // Only match this route's own stations against its own shapes — checking all
    // system-wide stations against every route (the previous behavior) is the difference
    // between sub-100ms and a multi-second main-thread stall on page load.
    const relevantStations = route.stationIds
      ? (() => {
          const idSet = new Set(route.stationIds);
          return stations.filter((s) => idSet.has(s.stopId));
        })()
      : stations;

    const directions = {};
    const indexByDirection = {};
    for (const direction of ['N', 'S']) {
      const shapes = route.track[direction];
      if (!shapes || !shapes.length) continue;
      directions[direction] = shapes;
      indexByDirection[direction] = new Map(
        relevantStations.map((s) => [s.stopId, bestShapeMatchForStation(shapes, s.lat, s.lon)])
      );
    }
    trackByRoute.set(route.routeId, directions);
    stationIndexByRoute.set(route.routeId, indexByDirection);
  }

  function getSubPath(routeId, direction, fromStopId, toStopId) {
    const cacheKey = `${routeId}|${direction}|${fromStopId}|${toStopId}`;
    if (subPathCache.has(cacheKey)) return subPathCache.get(cacheKey);

    const shapes = trackByRoute.get(routeId)?.[direction];
    const indexByStop = stationIndexByRoute.get(routeId)?.[direction];
    const from = indexByStop?.get(fromStopId);
    const to = indexByStop?.get(toStopId);

    // Only build a path if both stations confidently matched the *same* branch — if they
    // matched different shapes, we can't know how those branches connect from geometry alone.
    let result = null;
    if (shapes && from && to && from.shapeIdx === to.shapeIdx) {
      const track = shapes[from.shapeIdx];
      const fromIdx = from.pointIdx;
      const toIdx = to.pointIdx;
      const points = fromIdx <= toIdx ? track.slice(fromIdx, toIdx + 1) : track.slice(toIdx, fromIdx + 1).reverse();

      const cumDist = [0];
      for (let i = 1; i < points.length; i++) {
        cumDist.push(cumDist[i - 1] + distanceMeters(points[i - 1], points[i]));
      }
      result = { points, cumDist, total: cumDist[cumDist.length - 1] };
    }

    subPathCache.set(cacheKey, result);
    return result;
  }

  function positionAlongSegment(routeId, segment, now) {
    const duration = segment.toTimeMs - segment.fromTimeMs;
    const fraction = duration > 0 ? Math.min(1, Math.max(0, (now - segment.fromTimeMs) / duration)) : 1;

    const subPath = getSubPath(routeId, segment.direction, segment.fromStopId, segment.toStopId);
    if (subPath) return pointAtDistance(subPath, subPath.total * fraction);

    // Fall back to a straight line if the track/station lookup wasn't available.
    return [
      segment.fromLat + (segment.toLat - segment.fromLat) * fraction,
      segment.fromLon + (segment.toLon - segment.fromLon) * fraction,
    ];
  }

  return { trackByRoute, stationIndexByRoute, routeColors, addRoute, getSubPath, positionAlongSegment };
}
