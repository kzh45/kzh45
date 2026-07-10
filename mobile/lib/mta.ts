import Constants from 'expo-constants';

// Station names for the 7 line, keyed by the numeric GTFS stop ID (direction suffix N/S added at lookup time).
export const STATION_NAMES: Record<number, string> = {
  701: 'Flushing–Main St',
  702: 'Mets–Willets Point',
  705: '111 St',
  706: '103 St–Corona Plaza',
  707: 'Junction Blvd',
  708: '90 St–Elmhurst Av',
  709: '82 St–Jackson Hts',
  710: '74 St–Broadway',
  711: '69 St',
  712: '61 St–Woodside',
  713: '52 St',
  714: '46 St–Bliss St',
  715: '40 St–Lowery St',
  716: '33 St–Rawson St',
  718: 'Queensboro Plaza',
  719: 'Court Sq–23rd St',
  720: 'Hunters Point Av',
  721: 'Vernon Blvd–Jackson Av',
  723: 'Grand Central–42nd St',
  724: '5th Av',
  725: 'Times Sq–42nd St',
  726: '34th St–Hudson Yards',
};

// Order stations are listed in, from Flushing to Hudson Yards.
export const STATION_ORDER = Object.keys(STATION_NAMES).map(Number);

export function stationName(stationId: string): string {
  const numeric = parseInt(stationId, 10);
  return STATION_NAMES[numeric] || stationId;
}

export type Direction = 'N' | 'S';

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

export interface RouteUpdatesResponse {
  fetchedAt: number;
  trips: TripUpdate[];
  vehicles: unknown[];
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
