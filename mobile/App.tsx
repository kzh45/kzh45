import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Direction,
  StationGroups,
  getApiBaseUrl,
  groupByStationAndDirection,
  minutesUntil,
  stationName,
  STATION_ORDER,
} from './lib/mta';

const REFRESH_MS = 20000;
const MAX_RETRY_MS = 60000;
const MAX_ARRIVALS_SHOWN = 3;

export default function App() {
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
      const res = await fetch(`${getApiBaseUrl()}/api/7train`);
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
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
      if (pendingRetryId.current) clearTimeout(pendingRetryId.current);
    };
  }, [refresh]);

  const stationsWithData = STATION_ORDER.filter(
    (id) => groups[id] && groups[id][direction] && groups[id][direction].length
  ).map(String);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0f14" />
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.bullet}>
            <Text style={styles.bulletText}>7</Text>
          </View>
          <Text style={styles.title}>Train — Live Arrivals</Text>
        </View>
        <View style={styles.statusRow}>
          {isLoading && <ActivityIndicator size="small" color="#b933ad" style={styles.spinner} />}
          <Text style={[styles.statusText, isError && styles.statusTextError]}>{statusText}</Text>
        </View>
        {isError && (
          <Pressable style={styles.retryBtn} onPress={refresh}>
            <Text style={styles.retryBtnText}>Retry now</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.toggleRow}>
        <Pressable
          style={[styles.toggleBtn, direction === 'N' && styles.toggleBtnActive]}
          onPress={() => setDirection('N')}
        >
          <Text style={[styles.toggleText, direction === 'N' && styles.toggleTextActive]}>
            Flushing-bound
          </Text>
        </Pressable>
        <Pressable
          style={[styles.toggleBtn, direction === 'S' && styles.toggleBtnActive]}
          onPress={() => setDirection('S')}
        >
          <Text style={[styles.toggleText, direction === 'S' && styles.toggleTextActive]}>
            Manhattan-bound
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={stationsWithData}
        keyExtractor={(id) => id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>No upcoming trains found.</Text>}
        renderItem={({ item: stationId }) => {
          const times = groups[stationId][direction].slice(0, MAX_ARRIVALS_SHOWN);
          return (
            <View style={styles.station}>
              <Text style={styles.stationName}>{stationName(stationId)}</Text>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0b0f14' },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bullet: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#b933ad',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulletText: { color: 'white', fontWeight: '700', fontSize: 16 },
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
  toggleRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  toggleBtn: {
    flex: 1,
    paddingVertical: 8,
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
