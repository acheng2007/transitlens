import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.transitlens.app',
  appName: 'TransitLens',
  webDir: 'dist',
  // WebView background before the page paints: the logo's color, so launch goes from the
  // system's icon flash to the app without a black or white flash.
  backgroundColor: '#0b0d10',
  android: {
    // Native Gradle project lives in app/android/native/ (not app/android/android/).
    path: 'native',
  },
  plugins: {
    // Send transit requests through native HTTP to the configured public server.
    CapacitorHttp: { enabled: true },
    // MainActivity goes fullscreen/immersive itself. Capacitor's default inset handling would pad the
    // WebView by the camera cutout, shrinking the stereo view (which lays out eyes in physical mm).
    SystemBars: { insetsHandling: 'disable' },
  },
};

export default config;
