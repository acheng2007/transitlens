# TransitLens implementation roadmap

Status: planning only.
No implementation milestone is complete.
This roadmap follows the [PRD](PRD.md) and deliberately stops the first implementation task at the verified Cardboard bus demo.

## Delivery approach

Build working vertical slices with explicit verification gates.
Prioritize simplicity, quality, robustness, scalability, and maintainability over minimizing development effort.
Avoid speculative infrastructure and broad refactors that do not improve the required experience.

The dependency order is:

```text
0. Preserve and verify upstream
              |
1. Offline Cardboard bus demo
              |
       STOP AND VERIFY
              |
2. Server-side RTS integration
              |
3. Live Cardboard integration
              |
4. Outdoor alignment and reliability
              |
5. Mobile AR using shared tracking
              |
6. Transit enhancements and optional experiments
```

Tasks that require a physical phone, headset, credentials, or outdoor observations must be recorded explicitly.
An AI agent can prepare code and automated verification, but a production build or simulated heading is not evidence that real sensors or headset alignment work.
Do not mark those acceptance gates complete without their evidence.

## 0. Import, inspect, and verify the original app

**Outcome:** a reproducible, unchanged baseline that the team can compare against throughout migration.

- [ ] Import the designated upstream source into this repository, preserving license and attribution files that exist and recording the source revision.
- [ ] Inspect the full repository, including web, bus-service, voice-service, fixtures, Android, and casting.
- [ ] Record runtime versions, dependency installation, local startup, HTTPS phone access, and casting instructions.
- [ ] Run the original desktop fixture experience and production build.
- [ ] Run the original app on a supported Android phone in Cardboard.
- [ ] Verify rear camera, both eye views, head rotation, compass, focused bus card, and every calibration control.
- [ ] Verify desktop heading controls, camera-free development, and laptop casting.
- [ ] Capture baseline screenshots and a short hardware checklist with device, browser, orientation source, and observed issues.

**Gate:** the original Cardboard experience works before its application behavior changes.
If access to hardware is unavailable, finish inspection and setup, record the blocker, and obtain the required baseline observations before proceeding with the migration.

Initial reconnaissance successfully ran the original web production build.
No source was imported here.
Interactive browser verification did not finish, and hardware verification has not occurred.
Recheck the revision and dependencies when implementation begins.

## 1. Deliver the offline Cardboard bus demo

**Outcome:** turning in Cardboard reveals synthetic Gainesville buses, and holding a gaze shows a transit card.
No live service changes belong in this milestone.

### Shared model and fixture

- [ ] Define the shared `Bus`, location, and nearby-response contracts from the PRD.
- [ ] Keep optional vehicle metadata nullable and validate required coordinates and identifiers at data boundaries.
- [ ] Create one local fixture with 8-15 explicitly synthetic buses around a fixed Reitz Union location.
- [ ] Include routes 9, 12, 13, 20, 33, and 38 at varied bearings, plus missing-metadata examples.
- [ ] Derive bearings and distances from coordinates using existing geographic formulas rather than hand-entering inconsistent values.
- [ ] Load the fixture directly without polling any service or requesting GPS.
- [ ] Keep real phone orientation active in demo mode.

### Tracking and HUD adaptation

- [ ] Connect bus tracking without rewriting orientation or projection.
- [ ] Use a single frame-level result for angular offsets, visible buses, candidate selection, focused bus, and dwell progress.
- [ ] Pass that result to both eye draws and casting so drawing cannot advance focus state independently.
- [ ] Retain the ±7.5° focus cone, rank candidates by absolute offset with distance as a tie-breaker, and add a configurable dwell initially set to 750 ms.
- [ ] Define and verify target-loss and target-change behavior so small heading jitter does not rapidly switch cards.
- [ ] Render route-first bus markers in both eyes and transit-only information in the focused card.
- [ ] Preserve compass ticks, pinhole placement, off-screen guidance, and useful radar behavior.
- [ ] Display miles and mph where appropriate; omit unknown speed, delay, and occupancy values.
- [ ] Do not show an arrival time without prediction data or imply unknown delay status means on time.

### Start flow and development

- [ ] Brand the start screen as TransitLens and keep Cardboard as the active renderer.
- [ ] Make Demo the functioning data option for this checkpoint and label Live RTS as pending.
- [ ] Explain that Mobile AR is pending instead of presenting a selectable but broken mode.
- [ ] Use a 5 km radius by default and validate positive finite radius input.
- [ ] Preserve all headset calibration controls and TransitLens saved settings.
- [ ] Preserve keyboard heading adjustment and add the requested heading slider, both controlling one development heading value.
- [ ] Keep camera-denied testing available over a clear blank/test background.
- [ ] Show clear sensor permission and no-reading guidance without silently substituting desktop heading on a phone.

The final defaults remain Live RTS and Cardboard as required by the PRD.
Live becomes the default when milestone 3 makes it functional; the temporary demo-only checkpoint must be clearly described in the README.

**Verification gate:**

- [ ] Desktop: sweep heading through 360°, including 359° → 0°, and verify the fixture's expected bearings and movement direction.
- [ ] Focus: verify dwell, neighboring targets, target loss, empty radius results, and nullable metadata.
- [ ] Stereo: both eyes display the same selected bus and dwell state, with calibration still operational.
- [ ] Phone: physically rotate with live orientation and verify bus markers and cards in Cardboard.
- [ ] Demo: block RTS/backend access and confirm no dependency on network or GPS after app assets are loaded.
- [ ] Build: web type checking/build pass, and Android's imported-module compatibility is checked.
- [ ] Casting: laptop view shows the same bus focus as the headset.

**Stop here for review.**
Document the verified result and remaining hardware observations before starting the live service.
Offline demo here means the loaded app needs no RTS network access; installing and cold-launching the whole app without network is a separate packaging decision.

## 2. Build the server-side RTS bus service

**Outcome:** `GET /api/buses/nearby` returns normalized real Gainesville vehicles.

- [ ] Verify the official Gainesville RTS / BusTime API host, access requirements, vehicle endpoint, pagination or route filters, update cadence, rate limits, units, timestamps, and available metadata.
- [ ] Document verified source references and normalization decisions before coding against assumed field names.
- [ ] Adapt the existing FastAPI service structure into `bus-service`, reusing geographic math and suitable cache behavior.
- [ ] Read `RTS_API_KEY` only on the server and add a placeholder-only environment example.
- [ ] Normalize vehicle IDs, route, destination, coordinates, heading, speed, delay status, and passenger load into the shared contract.
- [ ] Reject invalid positions and tolerate missing optional fields, unknown values, and partial upstream responses.
- [ ] Implement the documented nearby parameters and response, with a 5 km default radius.
- [ ] Keep `fovDeg=360` useful for retrieving every nearby bus; apply cone filtering when a heading and narrower FOV are requested.
- [ ] Use the same Gainesville fixture for `demo=1`, ignoring supplied live coordinates.
- [ ] Add finite upstream timeouts, bounded caching, non-overlapping requests, rate-limit backoff, and last-good results.
- [ ] Distinguish successful empty results from upstream failure and expose failure/stale status explicitly without breaking the documented core response.
- [ ] Preserve source freshness separately from response generation time so cached positions do not appear newly observed.
- [ ] Add the web proxy route for `/api/buses` without exposing the key.

**Gate:** verify normalization, distance and bearing, wraparound, radius/FOV boundaries, missing fields, malformed responses, timeouts, stale cache, and missing credentials using deterministic upstream samples.
Then retrieve actual Gainesville vehicles with an authorized server-side key.
If credentials are unavailable, keep live retrieval acceptance pending and continue only work that does not depend on proving it.

## 3. Connect live buses to Cardboard

**Outcome:** the existing Cardboard bus HUD uses live GPS and normalized RTS data.

- [ ] Add a bus feed that polls the server at a cadence consistent with verified RTS limits and prevents overlapping requests.
- [ ] Request all nearby bearings and filter/reproject locally each animation frame using current heading.
- [ ] Recompute relative geometry when the user's position changes, keeping one authoritative tracking path.
- [ ] Keep cached positions during temporary failures, label their age, and show `LIVE DATA TEMPORARILY UNAVAILABLE` independently of whether buses are present.
- [ ] Keep successful no-bus results distinct from failure and waiting-for-GPS states.
- [ ] Handle GPS permission denial, unavailable fixes, poor accuracy, and retry without crashing.
- [ ] Keep Demo explicitly selectable; never silently replace live vehicles with fixture vehicles.
- [ ] Default the start screen to Live RTS, Cardboard, and 5 km once the live path works.
- [ ] Verify stopping/restarting releases streams, orientation listeners, timers, geolocation watches, and cast resources.

**Gate:** a supported phone retrieves real vehicles and shows them in both eyes at calculated bearings.
Verify a complete start, permission, tracking, failure, recovery, return-to-settings, and restart cycle.
Check demo again with the backend unavailable.

## 4. Validate alignment and hackathon reliability outdoors

**Outcome:** labels point reasonably toward actual RTS buses near UF, with repeatable calibration guidance.

- [ ] Test at known locations with independently checked bearings and observe multiple headings and buses.
- [ ] Compare the camera's effective horizontal FOV with each eye's crop and hardware zoom.
- [ ] Verify landscape transforms, phone orientation, lens spacing, tilt, horizontal shift, and view size on the target headset.
- [ ] Replace the inherited Atlanta declination assumption with a documented Gainesville value or supported correction strategy after verifying an authoritative source.
- [ ] Tune compass correction and smoothing from observed data, preserving wraparound behavior.
- [ ] Record GPS accuracy, compass drift, data age, observed bearing error, and stationary versus moving behavior.
- [ ] Check readability, card overlap, central visibility, permission recovery, screen wake, resize, and casting.
- [ ] Run the complete Cardboard acceptance checklist in the PRD and record evidence.

**Gate:** real-world observations support the claimed approximate alignment and the entire Cardboard MVP checklist passes.
Decide and document the team's acceptable bearing error from observed conditions rather than claiming pixel-perfect geographic alignment from untested sensors.
UI layout should still receive pixel-level visual review.

## 5. Add Mobile AR with shared tracking

**Outcome:** one full-screen camera/HUD view uses exactly the same feed, heading, geometry, and focus state as Cardboard.

- [ ] Add the Mobile AR layout option after live Cardboard passes its gate.
- [ ] Share camera acquisition, bus feed, geolocation, orientation, focus state, and error handling.
- [ ] Adjust viewport layout and effective camera crop/FOV through the existing projection helpers.
- [ ] Keep logical target selection independent of render calls and document expected FOV differences from viewport aspect ratio.
- [ ] Ensure the same bearing yields equivalent angular alignment in either layout, even when pixel positions differ.
- [ ] Verify portrait/landscape layout, camera cropping, safe areas, and mode switching without duplicate watchers or streams.
- [ ] Run all Mobile AR acceptance criteria and recheck Cardboard.

**Gate:** selecting Mobile AR shows one camera view with equivalent bus bearings and the same focus rules, while Cardboard remains operational.

## 6. Add transit features in independently verified slices

Start only after live geographic AR is stable.
Each enhancement must preserve demo, live Cardboard, and shared tracking behavior.

| Order | Enhancement | Required evidence |
| --- | --- | --- |
| 1 | Route colors and richer delay/occupancy labels | Verified RTS metadata, unknown-state handling, readable contrast |
| 2 | Nearby bus stops | Verified stop coordinates/IDs, distinct markers, uncluttered HUD |
| 3 | Arrival predictions | Authoritative prediction data associated with a specific stop/direction, freshness and unavailable states |
| 4 | Bus motion smoothing | Verified speed units/heading, bounded extrapolation, correction on fresh GPS, stopped-bus behavior |
| 5 | Hands-free head gestures or voice | Deliberate activation, no regression to gaze, accurate bus context |
| 6 | Pretrained bus detection | Acceptable on-device performance, separate geospatial path, no dependency for baseline operation |
| 7 | Route OCR and sensor fusion | Measured matching confidence, conflict handling, fallback to geographic identity |

Do not calculate "arriving in 2 min" from direct user-to-bus distance divided by speed.
Road routing, direction, stops, and service behavior make that an unreliable arrival prediction.

## Source migration map

Paths below refer to the inspected upstream source, which has not yet been imported into this repository.
Revalidate the map against the revision selected for import.
KEEP means preserve the working implementation, with only a reproduced issue justifying a targeted change.
MODIFY means adapt behavior in place.
REPLACE means substitute the domain-specific contract or data source while retaining useful infrastructure.
REMOVE EVENTUALLY means leave it intact until references and compatibility requirements have been resolved.

| Upstream file or group | Classification | Responsibility and planned treatment |
| --- | --- | --- |
| `web/src/camera.ts` | KEEP | Rear-camera selection, fallback camera ID, zoom capabilities, stream diagnostics |
| `web/src/stereo.ts` | KEEP | Both eye views, shared video stream, physical lens layout, canvas sizing, tilt and scale |
| `web/src/orientation.ts` | KEEP | Quaternion/Euler rear-camera direction, sensor/event fallback, vector smoothing; verify location-specific declination in milestone 4 |
| `web/src/geo.ts` | KEEP | Signed angle differences, normalization, effective camera FOV, `projectX` pinhole projection |
| `web/src/config.ts` | MODIFY | Device presets and calibration settings remain; adapt product defaults and persisted domain settings |
| `web/src/main.ts` | MODIFY | Startup, GPS/feed lifecycle, animation frames, calibration controls, heading controls, casting; swap bus state into existing loop |
| `web/index.html` | MODIFY | TransitLens branding, mode/data choices, radius, retained calibration setup |
| `web/src/style.css` | MODIFY | Preserve stereo/calibration layout; add only required start, debug, and later mobile layout styles |
| `web/vite.config.ts` | MODIFY | Keep casting, shared-fixture watch, HTTPS tunnel support; add bus proxy in milestone 2 |
| `web/src/cast/compositor.ts` | KEEP | Camera/HUD compositing; consume the same bus tracking/focus result |
| `web/src/cast/publisher.ts`, `rtc.ts`, `viewer.ts` | KEEP | WebRTC publication, transport, laptop viewer |
| `web/server/cast-signaling.ts`, `web/cast.html` | KEEP | Existing signaling and laptop entry point |
| `app/android/src/main.ts` | MODIFY | Native startup imports shared HUD modules; plan bus compatibility before changing exported interfaces |
| `app/android/src/native.ts`, `compass.ts`, `compass-calibration.ts`, `camera-fov.ts`, `screen-size.ts` | KEEP | Native bridge, compass calibration, camera FOV, physical dimensions |
| `app/android/src/location.ts`, `web/src/geo.ts` | KEEP | Native GPS and geographic helpers, checking consistency with existing web/server math |
| `app/android/native/**`, `capacitor.config.ts`, build configuration and asset scripts | KEEP | Native camera/compass plugins, permissions, build wrapper, Android packaging; rebrand only when needed |
| `web/package.json`, `web/tsconfig.json`, Android package/TypeScript/Vite configuration | MODIFY | Preserve build paths and dependencies needed by active code; change only for actual migration requirements |

The browser projection math is in `web/src/geo.ts`.
The existing bearing and distance implementations are in `bus-service/app/geo.py` and the Android geographic helper.
Do not accidentally replace one with newly invented formulas just because they live in different layers.

## Task handoff format

Every implementation task should identify its milestone and include:

1. The user-visible outcome and prerequisite gate.
2. The exact files or interfaces expected to change.
3. Invariants to preserve, especially stereo, orientation, projection, demo, and Android imports.
4. Acceptance checks covering the user flow and relevant edge cases.
5. Evidence of verification and any explicitly pending hardware or live-service checks.

Avoid mixing unrelated architecture cleanup, live integration, and rendering changes in one task.
If a safe, clearly scoped quality fix is needed, reproduce it, include its verification, and mention it in the handoff.
Update this roadmap and the README as functionality becomes usable so the next contributor can continue from a truthful project state.
