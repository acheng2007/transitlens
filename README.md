# TransitLens

Hold up your phone (or wear Google Cardboard), look down a Gainesville street, and identify nearby RTS buses by route and geographic bearing.
The existing camera, stereo layout, compass, pinhole projection, calibration controls, bottom minimap, and laptop casting power the experience.

## Current experience

The web app defaults to Live RTS, the full-screen Phone view, and a 5 km radius; Google Cardboard is one tap away on the start screen.
iPhone Safari is the primary target. The Phone view works held upright or sideways, and the app can be added to the Home Screen to open full screen.
TransitLens combines live RTS identification, an interactive street map, and a Gemini transit copilot.
Look toward a route marker, hold your gaze, then say "Hey Gemini, where is this bus going?"
Ask for routes to a destination, highlight a route, select a trip and find its stationary boarding stop.
Both eyes and casting share the same selection, route overlays, trip and voice state.
The server-side bus service retrieves and normalizes vehicles; the HUD shows route markers, dwell-selected transit cards, and nearby buses on the persistent minimap.
Missing transit metadata stays unknown, and no arrival estimates are invented.

The assistant uses server-side Gemini function calling, with browser speech recognition/synthesis and a short follow-up listening window.
"Read the bus sign" sends one small camera still to Gemini on request; regular questions use transit context only.
Route planning checks real ordered stop patterns and direction, with a boarding stop within 0.8 km straight-line distance.
Available arrivals are stop/route/direction-specific RTS predictions, not estimates from vehicle distance.
Guidance is approximate bearing and distance to the stop, not a verified pedestrian route.

An explicit showcase mode has ten moving synthetic vehicles on captured Gainesville RTS route geometry.
It can use Gemini when configured, or clearly labeled deterministic commands without a Gemini key.
Demo arrivals are scripted and never presented as live.
Live mode never substitutes demo vehicles.
Physical phone, headset, microphone and outdoor alignment acceptance remains pending.

## Run locally

Quick start for all three services:

```sh
./scripts/dev.sh
# If port 5173 is occupied: WEB_PORT=5174 ./scripts/dev.sh
```

The script installs isolated service dependencies, creates ignored environment files when absent, starts bus-service on 8003 and voice-service on 8002, and starts Vite.
Set `RTS_API_KEY` in `bus-service/.env` and `GEMINI_API_KEY` in `voice-service/.env`, then restart.
The default model is `gemini-3.8-flash`; override `GEMINI_MODEL` for your account.
No provider credential belongs in browser code.
For manual service setup, follow the instructions below.

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

- **Home screen**: live RTS indicator, nearby-bus cards (tap **Use my location**), and **Enter AR**. Settings (top right) holds every option, including **Appearance: System / Light / Dark**, which also themes the AR view and map.
- **Phone view** (default): hold the phone up, upright or sideways. Tap ✕ (or long-press) to go back.
- **Google Cardboard**: pick it on the start screen and turn the phone sideways. iPhones need size and FOV calibration.

The home screen includes an interactive schematic of captured RTS routes 9, 20 and 38, with an explicitly illustrative vehicle marker.
Type a destination or choose a shortcut to open your selected view and ask the copilot.
The copilot shows question and processing feedback, selectable trip cards with boarding and drop-off stops, arrival provenance, and explicit destination choices when names are ambiguous.
Its connection badge distinguishes a configured Gemini key, local commands, and an unavailable service.

Double-tap the middle to unlock calibration, then tap the middle to cycle controls (Phone: zoom, FOV; Cardboard: also tilt, spacing, shift, size) and the left/right thirds to adjust.

Open `http://localhost:5173/?dev=1` for desktop development with arrow-key heading controls and a clearly labeled fixed Reitz Union location.
Add `&camera=off` for a labeled blank background without requesting a camera.
Press Escape to return to settings on a keyboard.
Desktop mode fetches live RTS vehicles around that public location and does not use desktop GPS.
Enable casting and open `/cast.html` on the laptop to view the shared HUD over WebRTC.
The Vite proxy forwards `/api/buses` and `/api/transit` to port 8003 and retains the legacy service proxies.

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
Validated map and journey actions drive route overlays, stop markers and boarding guidance.
Direct route discovery and available arrival predictions are implemented; transfer planning and verified pedestrian paths remain pending.

## Ask Gemini

Enable **Hey Gemini + spoken replies** on the start screen.
Hold your gaze on a bus marker and ask "Where is this bus going?", "Is it delayed?", or "How full is it?"
Say "Show routes to Shands", "Highlight route 38", "Take the first option", "Close the map", or "Cancel guidance."
A seven-second follow-up listening window lets you continue without repeating the wake phrase.
Tap the voice control or press Space on desktop to listen directly.
**Ask** opens typed prompts and selectable trip cards when speech recognition is unavailable.

Routes and stop coordinates come from bus-service, and Gemini receives compact grounded tool results rather than computing reachability or geometry.
Ambiguous destination names require a specific stop choice.
A selected vehicle's exact destination coverage requires a matching pattern ID, not merely the same route number.
Stale/partial catalogs and unavailable predictions remain explicit.
The boarding marker uses straight-line bearing and distance, not walking directions.

"Read the bus sign" captures one JPEG with a maximum side of 640 pixels for the Gemini request.
No continuous camera stream is sent or stored, and images are not retained in conversation history.
Keep the destination display legible; unclear text cannot establish vehicle identity or intermediate stops.

Choose **Showcase demo** for fixed Reitz Union positioning and synthetic vehicles with live head orientation.
Desktop preview: `http://localhost:5173/?dev=1&camera=off&demo=1`.
Try "Show routes to Shands", then "Take the first option", "Close the map" and "Cancel guidance."
With no Gemini key, those commands are visibly labeled scripted/local tools, and bus-sign reading reports that Gemini is not connected.
Use [the showcase guide](docs/SHOWCASE.md) for a short presentation sequence.
See [verification](docs/GEMINI_VERIFICATION.md) for completed and pending checks.

## Routes and stops

When no copilot route or trip is selected, the minimap draws the focused bus's current RTS pattern and stops in the route's color.
The line uses the same projection as the bus markers in both eyes, casting, compact, expanded, and zoomed views.
It stays for three seconds after focus is lost and clears immediately when a different bus is focused.
Each pattern is fetched once per session; a missing pattern draws nothing rather than an invented line.
Showcase mode uses its captured fixture for this overlay without a live RTS lookup.

Bus-service exposes deterministic `/api/transit` endpoints for routes, patterns, nearby stops, stop-name search, and direct service between two stops or places.
Direct-service results name the boarding and drop-off stops and give an approximate straight-line bearing to the boarding stop.
They are labeled as direct-route coverage, not arrivals, transfers, or walking routes.
The Gemini copilot uses the companion `/api/buses/network` and `/api/buses/plan` endpoints for route discovery, predictions and stop guidance.
See [the bus-service API reference](bus-service/README.md#transit-routes-stops-and-direct-service) and [verification](docs/TRANSIT_ROUTES_VERIFICATION.md).

## Verification

```sh
cd web
npm test
npm run build
```

Backend tests and setup are in [bus-service/README.md](bus-service/README.md).
See [checkpoint verification](docs/LIVE_RTS_VERIFICATION.md) for completed checks and remaining physical-device gates.
See [transit routes verification](docs/TRANSIT_ROUTES_VERIFICATION.md) for the route, stop, and overlay evidence.
Android uses the shared RTS bus feed and transit HUD with native camera and compass calibration.
Its shared-module build is checked separately; physical APK acceptance remains pending.

## Product direction

Gemini now supports focused-bus questions, visual sign reading, direct-route discovery, highlighting and boarding-stop guidance.
Future work includes transfer-based journeys, verified pedestrian paths and hardware alignment acceptance.
See [PRD](docs/PRD.md), [roadmap](docs/ROADMAP.md), and [agent instructions](AGENTS.md).
Assign remaining work using the [parallel work plan](docs/PARALLEL_WORK.md), which defines eight workstreams, relevant files, dependencies, acceptance gates, and reusable task prompts.
