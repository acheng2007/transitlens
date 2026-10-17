# SkyLens (Android app)

Standalone APK (Capacitor). The web code is bundled into the app, and only adsb.lol / adsb.im are contacted. No voice, no casting, no demo data: it always shows live planes around the phone's GPS position.

## Using the app

- **Launch:** opens straight into the headset view (no splash or loading screen; Android 12+ only flashes the app icon briefly, which apps can't turn off). Android asks for location and camera the first time.
- **Settings:** ⚙ (top-right corner, outside both eye images) or long-press anywhere in the view.
  - Search radius (default 20 km), camera, lens spacing.
  - **Done** or back returns to the view.
  - If the view can't start (e.g. camera permission denied), settings open with the reason.
- **Compass calibration:** Settings → **🧭 Calibrate compass**. Draw a figure 8 with the phone while twisting it.
  - **Ring (coverage):** fills as the phone is turned through different orientations (14 field directions, 10 needed).
  - **Consistency (the quality measure):** a calibrated compass reads the same field strength whichever way the phone points. Each direction keeps a running average of the strength seen there; consistency is ± half the max–min spread, as a % of the median. **Good ≤ ±5%**, Fair ≤ ±10%, Poor above. *Calibrated* = 10 directions covered and Good consistency over at least 8 of them.
  - **Detail line:** the live field strength, the strength Earth's field model expects at your last GPS position, and Android's own 4-level rating (Unreliable/Low/Medium/High). That rating is vendor-defined and often stays Low indoors, so it's a hint only.
  - **Interference:** readings more than 25% off the expected strength (or outside 22–65 µT before any GPS fix) are ignored, and a warning shows.
  - Android does the actual calibration: `CompassPlugin.java` keeps the magnetometer running and reports what browsers don't expose. Logic: `src/compass-calibration.ts`.
- **Magnetic declination:** true north is corrected with the local declination from Android's World Magnetic Model (`GeomagneticField`, via `CompassPlugin.fieldModel`), computed on the first GPS fix and after moving 20 km, and saved for the next launch. `web/src/orientation.ts` still assumes Atlanta (−5.3°); `src/compass.ts` adds the difference. The info line shows it (`decl -4.6°`).
- **Fine-tuning in the headset:** double-tap the middle to unlock. Then middle tap = next setting (zoom → tilt → spacing → shift → size → fov → info), left/right = adjust.
- **Back in the view:** exits the app.
- **Live data:** adsb.lol rate-limits per IP. The app polls every 5–30 s, adapting to 429s and slow answers, and moves planes along their track in between. The info line shows the data age and poll interval.

## Build

Needs Node, the Android SDK (`ANDROID_HOME`), and **JDK 21+**. `scripts/gradle.mjs` switches to Android Studio's bundled `jbr` automatically if `JAVA_HOME` points at an older JDK.

```sh
cd app/android
npm ci
npm run apk          # tsc + vite build -> cap sync -> gradlew assembleDebug
npm run install-apk  # adb install -r (phone with USB debugging on)
```

APK: `native/app/build/outputs/apk/debug/app-debug.apk` (you can also copy it to the phone and sideload it). Debug builds install as **"SkyLens (debug)"** (`com.arplaneidentifier.app.debug`), next to the release build.

## Release

```sh
npm version patch        # or minor; versionName/versionCode come from package.json (0.1.0 -> code 100)
npm run apk:release      # -> native/app/build/outputs/apk/release/app-release.apk (signed)
adb install -r native/app/build/outputs/apk/release/app-release.apk
```

- **Signing:** `native/keystore.properties` (gitignored) points at the release keystore in `~/.android-keystores/` and holds its passwords.
- **Back up both files** somewhere safe. Without them, a new release can't update installed copies: they'd have to be uninstalled first, which loses their calibration.
- Without `keystore.properties`, `apk:release` builds an unsigned APK that won't install.
- To set signing up on another machine, copy both files there (update `storeFile` if the path differs).
- **First release on a phone that has an old debug build** (built before 2026-09-29, same app id): uninstall it first (`adb uninstall com.arplaneidentifier.app`). The signatures differ.
- **App icon:** made from `assets/logo.png`. To change it, replace the file and run `npm run assets`. `scripts/make-assets.mjs` writes the icon sources to `assets/generated/` (the adaptive icon is scaled automatically so the logo's farthest detail stays inside the circle launchers crop to), then `@capacitor/assets` generates every Android density into `native/`. It can also reformat `AndroidManifest.xml`; check the diff.

| Script | What |
|---|---|
| `npm run dev` | Desktop browser at http://localhost:5174/?dev=1 (arrow keys turn, Shift = 10°; camera optional). Live mode works through the dev proxy. No native features |
| `npm run sync` | Build the web bundle and copy it into `native/` (needed after every web change) |
| `npm run check` | Compare the in-app flight engine with flight-service's Python on flight-service's frozen snapshot (`flight-service/data`; the app itself has no demo data). Add `-- --live` to also test live adsb.lol data + route lookups. Needs `flight-service/.venv` |
| `npm run tables` | Regenerate `src/flights/tables.ts` (airlines, type names, ...) after changing them in `flight-service/app/normalize.py` |
| `npm run apk:release` | Signed release APK (see [Release](#release)) |
| `npm run assets` | Regenerate the app icon from `assets/logo.png` |
| `node scripts/gradle.mjs <task>` | Any Gradle task with the right JDK, e.g. `clean` |

Open `native/` in Android Studio for logcat and debugging. Inspect the WebView from desktop Chrome at `chrome://inspect` (debug builds only).

## Layout

- `src/`: app TypeScript.
  - `main.ts`: stereo view (opens on launch) + settings screen, forked from `web/src/main.ts` without voice, cast, fullscreen or demo code.
  - `native.ts`: permissions, back button, pause/resume.
  - The HUD, stereo layout, heading, camera and settings are imported unchanged from `web/src` through the `@web` alias.
- `src/flights/`: TypeScript port of flight-service.
  - `adsb.ts`: adsb.lol + route lookup, with caching, 429 back-off and last-good fallback.
  - `normalize.ts`: raw aircraft → `Plane`.
  - `nearby.ts`: radius filter, sort, and routes.
  - `feed.ts`: the HUD's `PlaneFeed`.
  - `tables.ts` is generated.
- `native/`: Gradle project generated by `npx cap add android`, committed.
  - Hand-edited files:
    - `app/src/main/AndroidManifest.xml`: permissions, `sensorLandscape`.
    - `MainActivity.java`: immersive fullscreen, draw under the cutout, keep screen on.
    - `CameraFovPlugin.java`: exact per-lens FOV for label placement.
    - `CompassPlugin.java`: magnetometer readings + Android's compass accuracy for the calibration screen, and Earth's field model (declination, expected strength) at a position.
    - `ScreenSizePlugin.java`: physical screen size, so the two eyes sit under the lenses on any phone. There's no phone selector; fine-tune with the in-headset calibration.
    - `app/build.gradle`: version from `package.json`, release signing, `.debug` suffix.
    - `values/styles.xml`: launch background `#0b0d10`, no splash image.
  - Don't edit `app/src/main/assets/public/`: it's regenerated by `cap sync`.
- `capacitor.config.ts`: `CapacitorHttp` on (adsb.lol has no CORS headers), `SystemBars.insetsHandling: 'disable'` (MainActivity handles fullscreen itself).
