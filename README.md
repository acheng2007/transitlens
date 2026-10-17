# TransitLens

Hold up your phone (or wear Google Cardboard), look down a Gainesville street, and identify nearby RTS buses by route and geographic bearing.
The existing camera, stereo layout, compass, pinhole projection, calibration controls, bottom minimap, and laptop casting power the experience.

## Current checkpoint

The web app now defaults to Live RTS, the full-screen Phone view, and a 5 km radius; Google Cardboard is one tap away on the start screen.
iPhone Safari is the primary target. The Phone view works held upright or sideways, and the app can be added to the Home Screen to open full screen.
The server-side bus service retrieves and normalizes vehicles; the HUD shows route markers, dwell-selected transit cards, and nearby buses on the persistent minimap.
Both eyes and casting receive the same selection state.
Missing transit metadata stays unknown, and no arrival estimates are invented.

The start screen scrolls, fullscreen and orientation locking are optional, and motion permission is requested directly from Start.
Safari's magnetic compass anchors the full rear-camera rotation, with location/date WMM2025 correction applied once.
All iPhones require device-specific size and FOV calibration.
Physical iPhone, Android browser, headset, and outdoor alignment checks remain pending, so iPhone support is not yet certified.

This user-authorized live-first checkpoint supersedes the earlier offline-demo-first sequence.
Synthetic buses, Gemini integration, transit route overlays, predictions, and navigation are deferred.
Live RTS never substitutes demo vehicles after a failure.

## Run locally

Start [bus-service](bus-service/README.md) with a server-only `RTS_API_KEY` in its ignored `.env`:

```sh
cd bus-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8003
```

In another terminal:

```sh
cd web
npm install
npm run dev
```

### Open it on your phone (iPhone first)

Phones need HTTPS for the camera, GPS, and compass. In a third terminal:

```sh
cd web
npm run phone
```

This opens a free Cloudflare quick tunnel (install once: `brew install cloudflared`, or `winget install Cloudflare.cloudflared` on Windows) and prints a QR code.
Scan it with the iPhone Camera app and open the link in Safari. The laptop's start screen at `http://localhost:5173` shows the same QR code.
The link changes each time `npm run phone` restarts.

On the phone, tap **Start AR** and allow camera, location, and motion; iPhone asks for motion only from that tap.
For an app icon that opens full screen, use **Share → Add to Home Screen** (re-add it after the link changes).

- **Phone view** (default): hold the phone up, upright or sideways. Tap ✕ (or long-press) for settings.
- **Google Cardboard**: pick it on the start screen and turn the phone sideways. iPhones need size and FOV calibration.

Double-tap the middle to unlock calibration, then tap the middle to cycle controls (Phone: zoom, FOV; Cardboard: also tilt, spacing, shift, size) and the left/right thirds to adjust.

Open `http://localhost:5173/?dev=1` for desktop development with arrow-key heading controls and a clearly labeled fixed Reitz Union location.
Add `&camera=off` for a labeled blank background without requesting a camera.
Press Escape to return to settings on a keyboard.
Desktop mode fetches live RTS vehicles around that public location and does not use desktop GPS.
Enable casting and open `/cast.html` on the laptop to view the shared HUD over WebRTC.
The Vite proxy forwards `/api/buses` to port 8003 and retains the legacy service proxies.

If RTS fails, cached buses remain with their retrieval age and `LIVE DATA TEMPORARILY UNAVAILABLE`.
A successful empty result says `No nearby buses`.
GPS waiting, denial, compass/correction waiting, and camera failure have distinct messages.
Camera failure allows a labeled blank background.
The minimap stays visible with a location fix, including an empty feed or unavailable heading.
Without heading it explicitly uses north up.

## Street map and compass distance

The bottom circular map uses MapLibre and OpenFreeMap streets with reported live vehicle positions, without road snapping.
It follows GPS and heading, independently of compass filtering.
Map opens a translucent expanded view in both eyes and suppresses the focused card.
Close returns to the compact map and preserves zoom.
Use the duplicated Map/Close and +/− buttons, or M, +/−, and Escape on a keyboard.
Escape closes the expanded map before leaving for settings.
Map controls do not trigger calibration.

The saved Compass distance (miles) defaults to 1 mile (1.609344 km).
All nearby disables this filter.
The limit applies to individual compass buses, edge arrows, dwell selection, and cards, while the map keeps the entire fetched feed.
Increasing this limit does not fetch beyond Search radius.
The map initially covers that search radius; each zoom changes its center-to-edge extent by a factor of two within 0.1-400 km.
Without GPS it waits for location; without compass it uses north up and labels the limitation.
Tile/WebGL failures show a labeled radar fallback without interrupting the compass or camera.
Roads require network access.
Map attribution is included in the headset and cast pixels.

One map renderer updates at most 15 times per second, with buffer pixel ratio capped at 2.
Both eyes and casting copy its composite frame.
Typed map actions in `web/src/map-state.ts` prepare shared controls for a later Gemini integration.
No assistant, destination search, route discovery, stops, arrivals, or navigation are added here.

## Verification

```sh
cd web
npm test
npm run build
```

Backend tests and setup are in [bus-service/README.md](bus-service/README.md).
See [checkpoint verification](docs/LIVE_RTS_VERIFICATION.md) for completed checks and remaining physical-device gates.
Android uses the shared RTS bus feed and transit HUD with native camera and compass calibration.
Its shared-module build is checked separately; physical APK acceptance remains pending.

## Product direction

Gemini remains a planned transit copilot with authoritative route discovery and validated map actions after geographic Cardboard is proven.
See [PRD](docs/PRD.md), [roadmap](docs/ROADMAP.md), and [agent instructions](AGENTS.md).
Assign remaining work using the [parallel work plan](docs/PARALLEL_WORK.md), which defines eight workstreams, relevant files, dependencies, acceptance gates, and reusable task prompts.
