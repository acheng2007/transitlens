# TransitLens Android app

The Capacitor shell displays live Gainesville RTS buses using the shared bus feed, route-first HUD, compass, gaze selection and bus radar.
Native camera FOV, screen measurement, compass calibration, location permissions and pause/resume behavior remain in place.
The native shell has no assistant or casting controls; the web application supplies the complete copilot experience.

## Setup

Install dependencies in both `web/` and `app/android/` because native builds import the shared web modules.
Start bus-service on port 8003 for desktop development.
Run `npm run dev` in `app/android/` and open `http://localhost:5174/?dev=1`.
Arrow keys rotate the desktop heading, with Shift for larger steps.
Live mode requires location access and does not substitute synthetic vehicles when the server fails.

For a packaged build, set `VITE_TRANSIT_API_BASE_URL` to your public HTTPS transit server before building.
This is a public server URL, never an RTS or Gemini credential.
The server must serve `/api/buses/nearby` with the normalized transit contract.
A native build without a valid HTTPS server URL reports that the transit service is not configured and does not make provider requests.
Desktop development uses Vite's bus-service proxy when no URL is configured.

```sh
VITE_TRANSIT_API_BASE_URL=https://transit.example.com npm run build
npm run apk
```

APK builds require Android SDK and JDK 21 or newer.
The build wrapper uses Android Studio's bundled JDK when available.
The application ID is `com.transitlens.app`, with `.debug` appended for debug builds.
The package identity is distinct from previously installed applications.

## Calibration and lifecycle

Camera lens FOV and screen size are measured through native bridges, with the shared fallback preset when measurements are unavailable.
The compass uses a local geomagnetic field model when available and labels missing correction as magnetic north.
No fixed geographic declination is assumed.
Double-tap the middle of the view to unlock calibration, then tap the middle to cycle settings and left or right to adjust.
Settings include zoom, tilt, lens spacing, horizontal shift, view size and projection FOV.
Long-press or tap the settings button to return to settings.
Backgrounding the app releases camera, orientation, location and bus polling resources.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Desktop development on port 5174 |
| `npm run build` | Type-check and build the shared-module native bundle |
| `npm run sync` | Build and synchronize Capacitor assets and plugins |
| `npm run apk` | Build the debug APK |
| `npm run apk:release` | Build the release APK |
| `npm run assets` | Generate native icons from the shared TransitLens bus logo |

Release signing uses the ignored `native/keystore.properties` configuration.
Keep release keystores and their passwords outside version control.
Physical device, headset, microphone, outdoor alignment and native bus-network acceptance remain pending until separately recorded.
