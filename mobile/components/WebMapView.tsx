import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { getApiBaseUrl } from '../lib/mta';

// Simplest possible mobile map: just embed the already-working web map instead of
// reimplementing it natively. Trades native look-and-feel for zero porting effort and
// reuses the exact same branch-aware track logic as the browser/kiosk versions.
export default function WebMapView() {
  return <WebView source={{ uri: `${getApiBaseUrl()}/map.html` }} style={styles.webview} />;
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#0b0f14' },
});
