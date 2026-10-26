<div align="center">
  <img src="web/public/icons/icon-192.png" alt="TransitLens logo" width="88" height="88">
  <h1>TransitLens</h1>
  <p><strong>Look down the street. Find your bus.</strong></p>
  <p>A live transit HUD for Gainesville RTS, with geographic bus markers, an interactive map, and a Gemini voice copilot.</p>
  <p>
    <a href="https://transitlens.vodka">Live demo</a> ·
    <a href="#quick-start">Quick start</a> ·
    <a href="#try-it">Try it</a> ·
    <a href="#development">Development</a> ·
    <a href="#deployment">Deployment</a>
  </p>
</div>

## Your next bus, in view

Point your phone toward the street or place it in Google Cardboard.
TransitLens uses GPS and compass heading to place nearby buses at their geographic bearings, with route numbers front and center.
Hold your gaze on a marker to see its destination and available vehicle information.

- **Live RTS data:** nearby vehicles, route patterns, stops, and available stop-specific arrival predictions.
- **Phone and Cardboard views:** a full-screen handheld HUD or synchronized stereo views with gaze selection and headset calibration.
- **Interactive map:** a persistent minimap with streets, route overlays, stops, and an expanded view.
- **Gemini copilot:** spoken or typed questions, direct-route discovery, route highlighting, and boarding-stop guidance.
- **Showcase mode:** ten moving synthetic buses around UF on captured RTS route geometry, with clearly labeled scripted arrivals.
- **Laptop casting:** share the camera and HUD through WebRTC, with recording from the viewer.

## Quick start

Requires **Node.js 24.12+**, **Python 3.11+**, and npm.
Run from the repository root:

```sh
./scripts/dev.sh
```

The script installs dependencies, creates local environment files, and starts all three services.
Open [localhost:5173](http://localhost:5173).
To use another web port, run `WEB_PORT=5174 ./scripts/dev.sh`.

Configure the generated environment files, then restart:

| File | Setting | Enables |
| --- | --- | --- |
| `bus-service/.env` | `RTS_API_KEY` | Live Gainesville RTS data |
| `voice-service/.env` | `GEMINI_API_KEY` | Gemini answers, sign reading, and generated speech |
| `voice-service/.env` | `GEMINI_MODEL` | Optional text-model override |

All keys stay on the server.
The service `.env.example` files list the available configuration options.
Without keys, choose **Showcase demo** for synthetic transit data and labeled local commands.

### Open on your phone

Camera, location, motion, and microphone features require a secure context.
For local phone access, install `cloudflared`, leave the development server running, and open a second terminal:

```sh
cd web
npm run phone
```

Scan the printed QR code and open the HTTPS link on your phone.
The tunnel URL changes when restarted.
Allow the requested permissions when entering AR; iPhone Safari requests motion access from that gesture.
Choose Phone or Google Cardboard in settings.
On iPhone, **Share → Add to Home Screen** provides an app-style full-screen launch.

## Try it

Enable **Hey Gemini + spoken replies**, look toward a bus marker, and start a question with "Hey Gemini".

| Say | Explore |
| --- | --- |
| "Where is this bus going?" | The focused vehicle's destination |
| "Show routes to Shands" | Direct routes and destination choices |
| "Highlight route 38" | A route overlay on the map |
| "Take the first option" | A proposed trip and its boarding stop |
| "Enlarge the minimap" | The expanded map |
| "Close the map" | The compact HUD |
| "Cancel guidance" | Clear boarding guidance |
| "Read the bus sign" | An explicit camera-still request |

Each spoken question needs a fresh wake phrase.
Say "Hey Gemini" during playback to interrupt and ask again.
Use **Ask** for typed input when speech recognition is unavailable.
Generated speech falls back to browser speech when needed.

For a desktop showcase without camera access, open:

```text
http://localhost:5173/?dev=1&camera=off&demo=1
```

Desktop development uses a fixed Reitz Union location and arrow keys to adjust heading.
Demo mode preserves real phone orientation and uses synthetic vehicles; live mode never substitutes demo data during an outage.
Street tiles and cloud features still require network access.

**Calibration:** double-tap the center to unlock, tap the center to cycle controls, and tap left or right to adjust.
Cardboard supports camera zoom, projection FOV, tilt, lens spacing, horizontal shift, and image size.
Long-press to return to settings.

**Casting:** enable casting on the start screen, then open `/cast.html` on the laptop.
The devices need a working peer-to-peer network path.
The viewer can record the stream as WebM.

## How it works

```text
Gainesville RTS → Bus service → Shared transit state → Phone / Cardboard / Cast
                                      ↕
                              Voice service + Gemini
```

The web app uses Vite, TypeScript, and MapLibre.
Two FastAPI services supply normalized transit data and assistant responses.
Deterministic code computes bearings and route reachability; Gemini interprets requests, and the client validates actions before applying them to shared state.

| Directory | Responsibility |
| --- | --- |
| `web/` | Camera, compass, HUD, map, browser voice, and casting |
| `bus-service/` | RTS integration, caching, route queries, and predictions |
| `voice-service/` | Gemini requests, conversation state, actions, and speech |
| `shared/` | TypeScript contracts and transit fixtures |
| `app/android/` | Capacitor shell and native sensor bridges |
| `deploy/` | Container builds and Compose configuration |
| `scripts/` | Local startup, managed hosting, and production smoke checks |

## Development

The web server runs on **5173**, bus service on **8003**, and voice service on **8002**.
Vite proxies API requests to the Python services.
Both FastAPI services expose interactive API documentation at `/docs` on their own ports.
Shared browser contracts live in [`shared/transit.ts`](shared/transit.ts) and [`shared/assistant.ts`](shared/assistant.ts).

Run the web checks:

```sh
cd web
npm test
npm run build
```

Run backend checks from the repository root after the quick-start dependency installation:

```sh
(cd bus-service && .venv/bin/python -m unittest discover -s tests -v)
(cd voice-service && .venv/bin/python -m pip install -r requirements-dev.txt)
(cd voice-service && .venv/bin/python -m pytest tests)
```

The browser voice harness at `/src/voice/dev.html` supports scripted input without a microphone or provider calls.

<details>
<summary><strong>Android builds</strong></summary>

Install dependencies in both `web/` and `app/android/`, since native builds import shared web modules.
APK packaging requires the Android SDK and JDK 21+.

```sh
cd app/android
npm ci
cp .env.example .env
# Set VITE_TRANSIT_API_BASE_URL to your public HTTPS transit server in .env.
npm run apk
```

The server must serve `/api/buses/nearby`; its URL is public configuration, never a provider key.
Use `npm run build` to check the native bundle without packaging an APK.
The native shell includes the shared transit HUD and native camera, compass, and location bridges; the complete assistant and casting experience lives in the web app.
Release signing uses the ignored `native/keystore.properties` file.

</details>

## Deployment

<details>
<summary><strong>Docker Compose</strong></summary>

From the repository root:

```sh
cp deploy/.env.example deploy/.env
# Set RTS_API_KEY, GEMINI_API_KEY, and PUBLIC_URL in deploy/.env.
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait
```

The production gateway serves built web assets and proxies the private APIs at `http://127.0.0.1:8080`.
Place an HTTPS reverse proxy or named tunnel in front of it for phone access.
Check `/healthz`, `/api/buses/health`, and `/api/voice/health` for readiness.
Health checks report process readiness and configuration; verify live providers separately.

The fixture-only production smoke check uses an isolated stack with provider keys cleared:

```sh
docker compose --env-file deploy/.env.example -f deploy/compose.yaml build
WEB_PORT=8088 docker compose -p transitlens-smoke --env-file deploy/.env.example -f deploy/compose.yaml -f deploy/compose.smoke.yaml up -d --no-build --wait
node scripts/smoke-production.mjs
docker compose -p transitlens-smoke --env-file deploy/.env.example -f deploy/compose.yaml -f deploy/compose.smoke.yaml down
```

</details>

<details>
<summary><strong>Managed hosting</strong></summary>

[`render.yaml`](render.yaml) defines a managed service using `scripts/build-managed.sh` and `scripts/serve-managed.py`.
Create a Render Blueprint from the repository and set `RTS_API_KEY` and `GEMINI_API_KEY` as server-side secrets.
Only the gateway is public; both Python services listen on loopback.
Verify the health endpoints and phone permissions through the resulting HTTPS URL.

</details>

Use one instance and one worker per Python service for the current deployment.
Transit caches, provider budgets, speech identifiers, and conversation state are process-local.
Casting currently supports one active wearer/viewer pair per instance; multi-user casting and cross-network relay support require additional work.

## Current boundaries

Route discovery supports **direct trips**.
Guidance shows approximate straight-line bearing and distance to a stationary boarding stop, rather than verified walking directions.
Route coverage, active vehicles, and arrival predictions are distinct; missing metadata stays unknown.
Temporary RTS failures retain available cached data with freshness and an unavailable-status message.

Ordinary assistant questions use transit context.
Only an explicit bus-sign request sends one bounded JPEG camera still to Gemini; images are not retained in conversation history.
Browser speech recognition may use a network service and varies by browser.

Transfer planning, verified pedestrian paths, and physical phone, headset, microphone, outdoor alignment, and cast-network acceptance remain pending.
