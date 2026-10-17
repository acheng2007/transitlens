import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.arplaneidentifier.app',
  appName: 'SkyLens',
  webDir: 'dist',
  // WebView background before the page paints: the logo's color, so launch goes from the
  // system's icon flash to the app without a black or white flash.
  backgroundColor: '#0b0d10',
  android: {
    // Native Gradle project lives in app/android/native/ (not app/android/android/).
    path: 'native',
  },
  plugins: {
    // Patches fetch() to go through native HTTP: api.adsb.lol sends no CORS headers, and this
    // also lets us set the User-Agent adsb.lol checks.
    CapacitorHttp: { enabled: true },
    // MainActivity goes fullscreen/immersive itself. Capacitor's default inset handling would pad the
    // WebView by the camera cutout, shrinking the stereo view (which lays out eyes in physical mm).
    SystemBars: { insetsHandling: 'disable' },
  },
};

export default config;
