import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import WebMapView from './components/WebMapView';
import {
  Direction,
  EXPRESS_COMPANIONS,
  PICKER_ROUTES,
  ROUTE_COLORS,
  Station,
  StationGroups,
  fetchRouteStations,
  getApiBaseUrl,
  groupByStationAndDirection,
  minutesUntil,
  routesParamFor,
  textColorFor,
} from './lib/mta';

const REFRESH_MS = 20000;
const MAX_RETRY_MS = 60000;
const MAX_ARRIVALS_SHOWN = 3;

type ViewMode = 'list' | 'map';

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [route, setRoute] = useState('7');
  const [stations, setStations] = useState<Station[]>([]);
  const [direction, setDirection] = useState<Direction>('S');
  const [groups, setGroups] = useState<StationGroups>({});
  const [statusText, setStatusText] = useState('Loading…');
  const [isError, setIsError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const consecutiveErrors = useRef(0);
  const pendingRetryId = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (pendingRetryId.current) clearTimeout(pendingRetryId.current);
    if (!mounted.current) return;
    setIsLoading(true);

    try {
      const res = await fetch(`${getApiBaseUrl()}/api/lines?routes=${routesParamFor(route)}&include=trips`);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();

      if (!mounted.current) return;
      setGroups(groupByStationAndDirection(data.trips));
      consecutiveErrors.current = 0;
      setIsError(false);
      setStatusText(`Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`);
      setIsLoading(false);

      pendingRetryId.current = setTimeout(refresh, REFRESH_MS);
    } catch (err) {
      if (!mounted.current) return;
      consecutiveErrors.current += 1;
      const retryDelay = Math.min(REFRESH_MS * 2 ** consecutiveErrors.current, MAX_RETRY_MS);
      const message = err instanceof Error ? err.message : String(err);

      setIsError(true);
      setStatusText(`Error loading data: ${message} — retrying in ${Math.round(retryDelay / 1000)}s`);
      setIsLoading(false);

      pendingRetryId.current = setTimeout(refresh, retryDelay);
    }
  }, [route]);

  useEffect(() => {
    mounted.current = true;

    // Route changed: clear the stale board, load the new station order, start polling.
    setGroups({});
    setStations([]);
    fetchRouteStations(route)
      .then((s) => {
        if (mounted.current) setStations(s);
      })
      .catch(() => {
        // Board still renders arrivals grouped by stop ID; names just stay blank until retry.
      });
    refresh();

    return () => {
      mounted.current = false;
      if (pendingRetryId.current) clearTimeout(pendingRetryId.current);
    };
  }, [refresh, route]);

  const stationsWithData = stations.filter(
    (s) => groups[s.stopId] && groups[s.stopId][direction] && groups[s.stopId][direction].length
  );

  const routeColor = ROUTE_COLORS[route] || '#b933ad';
  // The S-direction station order starts at the northern terminal — each toggle names
  // the terminal that direction heads toward.
  const northLabel = stations.length ? `To ${stations[0].name}` : 'Northbound';
  const southLabel = stations.length ? `To ${stations[stations.length - 1].name}` : 'Southbound';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0f14" />

      <View style={styles.modeRow}>
        <Pressable
          style={[styles.modeBtn, viewMode === 'list' && styles.modeBtnActive]}
          onPress={() => setViewMode('list')}
        >
          <Text style={[styles.modeText, viewMode === 'list' && styles.modeTextActive]}>List</Text>
        </Pressable>
        <Pressable
          style={[styles.modeBtn, viewMode === 'map' && styles.modeBtnActive]}
          onPress={() => setViewMode('map')}
        >
          <Text style={[styles.modeText, viewMode === 'map' && styles.modeTextActive]}>Map</Text>
        </Pressable>
      </View>

      {viewMode === 'map' ? (
        <WebMapView />
      ) : (
        <>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={[styles.bullet, { backgroundColor: routeColor }]}>
            <Text style={[styles.bulletText, { color: textColorFor(routeColor) }]}>{route}</Text>
          </View>
          <Text style={styles.title}>Live Arrivals</Text>
        </View>
        <View style={styles.statusRow}>
          {isLoading && <ActivityIndicator size="small" color={routeColor} style={styles.spinner} />}
          <Text style={[styles.statusText, isError && styles.statusTextError]}>{statusText}</Text>
        </View>
        {isError && (
          <Pressable style={styles.retryBtn} onPress={refresh}>
            <Text style={styles.retryBtnText}>Retry now</Text>
          </Pressable>
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow} contentContainerStyle={styles.pickerContent}>
        {PICKER_ROUTES.map((r) => {
          const color = ROUTE_COLORS[r] || '#8b98a5';
          const selected = r === route;
          return (
            <Pressable
              key={r}
              style={[styles.routeChip, { backgroundColor: color }, selected && styles.routeChipSelected]}
              onPress={() => setRoute(r)}
            >
              <Text style={[styles.routeChipText, { color: textColorFor(color) }]}>{r}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.toggleRow}>
        <Pressable
          style={[styles.toggleBtn, direction === 'N' && styles.toggleBtnActive]}
          onPress={() => setDirection('N')}
        >
          <Text style={[styles.toggleText, direction === 'N' && styles.toggleTextActive]} numberOfLines={1}>
            {northLabel}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.toggleBtn, direction === 'S' && styles.toggleBtnActive]}
          onPress={() => setDirection('S')}
        >
          <Text style={[styles.toggleText, direction === 'S' && styles.toggleTextActive]} numberOfLines={1}>
            {southLabel}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={stationsWithData}
        keyExtractor={(s) => s.stopId}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>No upcoming trains found.</Text>}
        renderItem={({ item: station }) => {
          const times = groups[station.stopId][direction].slice(0, MAX_ARRIVALS_SHOWN);
          return (
            <View style={styles.station}>
              <Text style={styles.stationName}>{station.name}</Text>
              <View style={styles.arrivals}>
                {times.map((t, i) => (
                  <Text key={i} style={[styles.arrivalText, i === 0 && styles.arrivalNext]}>
                    {minutesUntil(t)} min
                  </Text>
                ))}
              </View>
            </View>
          );
        }}
      />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0b0f14' },
  modeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  modeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#232b36',
  },
  modeBtnActive: { backgroundColor: '#141a22', borderColor: '#b933ad' },
  modeText: { color: '#8b98a5', fontSize: 13, fontWeight: '600' },
  modeTextActive: { color: '#e6edf3' },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bullet: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulletText: { fontWeight: '700', fontSize: 16 },
  title: { color: '#e6edf3', fontSize: 20, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  spinner: { marginRight: 2 },
  statusText: { color: '#8b98a5', fontSize: 13, flexShrink: 1 },
  statusTextError: { color: '#b1201e' },
  retryBtn: {
    alignSelf: 'flex-start',
    borderColor: '#b1201e',
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginTop: 6,
  },
  retryBtnText: { color: '#b1201e', fontSize: 13 },
  // Horizontal ScrollViews don't reliably size to their children's height — without an
  // explicit height the 30px chips get clipped at the bottom on device.
  pickerRow: { flexGrow: 0, height: 40, paddingHorizontal: 16, marginBottom: 6 },
  pickerContent: { gap: 6, paddingRight: 16, alignItems: 'center' },
  routeChip: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.55,
  },
  routeChipSelected: { opacity: 1, borderWidth: 2, borderColor: '#e6edf3' },
  routeChipText: { fontWeight: '700', fontSize: 12 },
  toggleRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  toggleBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#232b36',
    alignItems: 'center',
  },
  toggleBtnActive: { backgroundColor: '#141a22', borderColor: '#b933ad' },
  toggleText: { color: '#8b98a5', fontSize: 13, fontWeight: '600' },
  toggleTextActive: { color: '#e6edf3' },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 8 },
  station: {
    backgroundColor: '#141a22',
    borderWidth: 1,
    borderColor: '#232b36',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  stationName: { color: '#e6edf3', fontWeight: '600', fontSize: 14, flexShrink: 1, marginRight: 8 },
  arrivals: { flexDirection: 'row', gap: 10 },
  arrivalText: { color: '#8b98a5', fontSize: 13 },
  arrivalNext: { color: '#e6edf3', fontWeight: '700' },
  empty: { color: '#8b98a5', fontStyle: 'italic', textAlign: 'center', marginTop: 24 },
});
