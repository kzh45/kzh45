import Constants from 'expo-constants';

// Boards a rider can pick. Express variants aren't separate entries — picking the 6 or 7
// folds their diamond trains into the same board, since a rider on the platform cares
// about both.
export const PICKER_ROUTES = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'GS', 'FS', 'H'] as const;
export const EXPRESS_COMPANIONS: Record<string, string> = { 6: '6X', 7: '7X' };

// MTA's canonical public palette (mirrors CANONICAL_ROUTE_COLORS server-side) — a tiny
// duplicate beats fetching the 180KB geometry payload just to color 25 picker chips.
export const ROUTE_COLORS: Record<string, string> = {
  1: '#EE352E', 2: '#EE352E', 3: '#EE352E',
  4: '#00933C', 5: '#00933C', 6: '#00933C',
  7: '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6',
  B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  G: '#6CBE45',
  J: '#996633', Z: '#996633',
  L: '#A7A9AC',
  N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  GS: '#808183', FS: '#808183', H: '#808183',
};

export function textColorFor(color: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#0b0f14' : '#fff';
}

export type Direction = 'N' | 'S';

export interface Station {
  stopId: string;
  name: string;
}

export interface StopTimeUpdate {
  stopId: string;
  arrival: number | null;
  departure: number | null;
}

export interface TripUpdate {
  tripId: string;
  routeId: string;
  stopTimeUpdates: StopTimeUpdate[];
}

export type StationGroups = Record<string, Record<Direction, number[]>>;

export function groupByStationAndDirection(trips: TripUpdate[]): StationGroups {
  const groups: StationGroups = {};

  for (const trip of trips) {
    for (const stu of trip.stopTimeUpdates) {
      const time = stu.arrival || stu.departure;
      if (!time || time < Date.now() - 30000) continue; // skip stale/past predictions

      const direction = stu.stopId.slice(-1) as Direction;
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

export function minutesUntil(timestampMs: number): number {
  const diffMs = timestampMs - Date.now();
  return Math.max(0, Math.round(diffMs / 60000));
}

// Derive the backend URL from the Metro dev server's LAN address (e.g. "192.168.1.156:8081")
// so the app reaches the Express API on the same machine without manual configuration.
export function getApiBaseUrl(): string {
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    return `http://${host}:3000`;
  }
  return 'http://localhost:3000';
}

// Stations for one route in line order (S-direction start -> end), from the backend's
// schedule-derived ordering. Cached by the browser layer via Cache-Control.
export async function fetchRouteStations(routeId: string): Promise<Station[]> {
  const res = await fetch(`${getApiBaseUrl()}/api/routes/${routeId}/stations`);
  if (!res.ok) throw new Error(`Stations API error ${res.status}`);
  const data = await res.json();
  return data.stations;
}

export function routesParamFor(routeId: string): string {
  const companion = EXPRESS_COMPANIONS[routeId];
  return companion ? `${routeId},${companion}` : routeId;
}
