# TransitLens PRD

## AR Gainesville RTS Bus Identifier

Status: product specification with an active live-first implementation checkpoint.
The implementation roadmap is in [ROADMAP.md](ROADMAP.md).
The historical first task below is superseded by the current user-authorized checkpoint.

## Current implementation checkpoint: Live RTS Cardboard

The latest user instruction authorizes a live-first web migration for iPhone Safari and Android Chrome.
This supersedes the earlier requirement to implement an offline bus demo first.
The current bounded scope is bus-service, normalized live vehicles, route-first compass markers, dwell cards, persistent minimap, casting, permission recovery, and iPhone sensor handling.
The street-map milestone adds OpenFreeMap roads, compact/expanded shared map controls, and a saved independent 1-mile compass filter.
Gemini, synthetic buses, transit route overlays, arrivals, navigation, and Mobile AR are deferred.
A later transit-data milestone adds RTS routes, stops, direct-service queries, and the focused bus's route on the minimap; see [its verification](TRANSIT_ROUTES_VERIFICATION.md).
The longer-term product requirements below remain planned.
See [verification evidence](LIVE_RTS_VERIFICATION.md) before claiming hardware support or geographic alignment.

## Product update: interactive Gemini transit copilot

Gemini API is the planned assistant provider.
Use server-side `GEMINI_API_KEY`, with "Hey Gemini" as the planned wake phrase.
Preserve the existing speech interaction infrastructure, initially using browser speech recognition and synthesis.
The examples below use the Gemini assistant.

This update records the user's subsequent direction and takes precedence over conflicting priorities in the original specification below.
The desired experience feels similar to Sky-C2 adapted to Gainesville buses, with a game-like transit HUD.
Preserve the top compass, bottom minimap, and existing Gemini capabilities as part of the intended product.
Gemini must grow beyond answering questions about the focused vehicle into controlling the map and helping discover routes.

Example requests include "Show me all routes that go to this location" and "Enlarge the minimap to show routes around me and guide me towards them."
Support route highlighting, compact/expanded map views, destination clarification, boarding-stop selection, and cancellation through voice.
Keep the compact minimap visible during voice responses.
Share all map, focus, route, and guidance state across both Cardboard eyes, casting, and Mobile AR.

Use authoritative routes, stops, patterns, service information, and available predictions to ground answers.
Gemini requests transit tools and returns structured actions; deterministic application code validates and applies those actions.
Guide to stationary boarding stops rather than moving buses, distinguishing approximate directional cues from verified pedestrian routing.
Direct-route discovery is in scope; a general transfer-based journey planner is not required initially.

Gemini transit interactions are core planned functionality after the geographic Cardboard foundation, rather than optional voice stretch work.
This supersedes the original voice-only-as-stretch framing and the blanket route-planning non-goal only for the bounded discovery and stop-guidance scope above.
The first implementation checkpoint remains the offline bus-focused Cardboard demo.
No application implementation is authorized by this documentation update alone.
See [AGENTS.md](../AGENTS.md) and [the roadmap's transit copilot milestone](ROADMAP.md#4a-build-the-gemini-transit-copilot-and-interactive-map) for implementation guidance.

## Product Vision

TransitLens is an augmented-reality public transit interface for Gainesville RTS.

A user can point their phone toward the real world and see live RTS buses positioned in the direction they actually are, along with route, destination, arrival, and vehicle information.

The PRIMARY experience is Google Cardboard:

```text
Put phone in headset
    ↓
look around naturally
    ↓
see RTS buses in stereoscopic AR
    ↓
look directly at a bus
    ↓
information card appears
```

TransitLens should ALSO support a normal handheld mobile AR mode.

Cardboard mode is the main hackathon experience.
Mobile AR mode is a secondary development, accessibility, and fallback experience.

## Existing Codebase

IMPORTANT: Do NOT rebuild the AR/orientation system from scratch.

Study and reuse the existing implementation for:

- phone camera
- Google Cardboard stereo rendering
- device orientation
- compass heading
- heading smoothing
- geolocation
- bearing calculations
- field-of-view filtering
- pinhole screen projection
- Cardboard calibration
- HUD
- focus cone
- demo fixtures
- desktop development mode
- Android support
- casting to laptop

TransitLens tracks Gainesville RTS buses.
Preserve working infrastructure whenever possible.

## Product Modes

TransitLens has TWO rendering modes.

### Mode 1: Cardboard AR

PRIMARY EXPERIENCE.

The phone is placed inside Google Cardboard.

```text
LEFT EYE             RIGHT EYE
camera + HUD         camera + HUD
```

Each eye displays the same real-world camera feed and corresponding AR overlays using the existing stereo system.

Preserve:

- stereo layout
- lens spacing
- zoom calibration
- FOV calibration
- headset tilt correction
- horizontal shift correction
- headset size adjustment
- orientation handling

The Cardboard experience should remain operational throughout development.

### Mode 2: Mobile AR

SECONDARY EXPERIENCE.

Display one full-screen camera feed:

```text
┌─────────────────────────────┐
│                             │
│       ROUTE 38              │
│    Gainesville Place        │
│           ↓                 │
│          🚌                 │
│                             │
└─────────────────────────────┘
```

Mobile mode uses the EXACT SAME:

- GPS
- orientation
- bus data
- bearing math
- FOV calculations
- focus logic

Only the rendering layout differs.
Do not create two independent tracking systems.

```text
          Bus Tracking State
                  |
       ┌──────────┴──────────┐
       ↓                     ↓
Cardboard Renderer     Mobile Renderer
```

## Start Screen

```text
TransitLens

Mode:
[ Google Cardboard ]
[ Mobile AR ]

Data:
[ Live RTS ]
[ Demo ]

Search Radius:
[ 5 km ]

[ START ]
```

Default mode: Google Cardboard.
Default data: Live RTS.

## Core User Story

A UF student is waiting near campus.

They:

1. Open TransitLens.
2. Select Google Cardboard.
3. Grant camera, orientation, and geolocation permissions.
4. Insert their phone into Cardboard.
5. Look down the street.
6. TransitLens fetches nearby RTS vehicles.
7. Bus icons appear at their real geographic bearings.
8. Turning their head causes the bus indicators to move appropriately.
9. Looking directly toward a bus selects it.
10. A transit information card appears.

Example:

```text
        ROUTE 38
     Gainesville Place

        Arriving 2m
         0.2 miles
           18 mph

             ↓
            🚌
```

## MVP Definition

MVP means:

"Live Gainesville buses appear at approximately correct real-world bearings while the user looks around through Google Cardboard."

Nothing else is required for the core MVP.

## Backend

Implement the server-side RTS integration in `bus-service`.

Endpoint: `GET /api/buses/nearby`

Parameters:

- `lat`
- `lon`
- `heading`
- `fovDeg`
- `radiusKm`
- `demo`

Example:

```text
GET /api/buses/nearby?lat=29.6465&lon=-82.3478&heading=90&fovDeg=60&radiusKm=5
```

Response:

```json
{
  "center": {
    "lat": 29.6465,
    "lon": -82.3478
  },
  "demo": false,
  "fetchedAt": "...",
  "buses": [
    {
      "id": "2417",
      "route": "38",
      "destination": "Gainesville Place",
      "lat": 29.6481,
      "lon": -82.3452,
      "headingDeg": 82,
      "speedMph": 18,
      "delayed": false,
      "passengerLoad": "HALF_EMPTY",
      "distanceKm": 0.31,
      "bearingDeg": 54,
      "offsetDeg": 4
    }
  ]
}
```

## Bus Data Model

Create a shared structure approximately like:

```ts
type Bus = {
  id: string;
  route: string;
  destination: string | null;
  lat: number;
  lon: number;
  headingDeg: number | null;
  speedMph: number | null;
  delayed: boolean | null;
  passengerLoad: string | null;
  distanceKm: number;
  bearingDeg: number;
  offsetDeg?: number;
};
```

Do not assume optional RTS fields are always available.
UI must degrade gracefully.

## RTS Data Source

Use Gainesville RTS / BusTime live vehicle data.

Useful fields include:

- vehicle ID
- latitude
- longitude
- vehicle heading
- route
- destination
- speed
- delayed status
- passenger load

External RTS API calls MUST happen server-side.

Environment variable:

```text
RTS_API_KEY=...
```

Never expose this key in browser code.

## Geographic Math

Reuse the existing geographic projection math.

For each bus:

1. Calculate distance user → bus.
2. Calculate bearing user → bus.
3. Compare bus bearing against camera heading.
4. Calculate signed offset.
5. Filter by field of view.
6. Project angle onto display.

Signed difference:

```text
diff = ((bearing - heading + 540) % 360) - 180
```

Visible if:

```text
abs(diff) <= fovDeg / 2
```

Preserve the existing pinhole projection implementation where possible.
Do not replace working math just for code cleanliness.

## Cardboard Rendering

Cardboard is the priority renderer.

For every nearby bus:

1. Determine its angular offset from camera center.
2. Render a bus indicator in BOTH eye views.
3. Keep the center of the user's view unobstructed.
4. Use the existing compass/header style where practical.
5. Update positions every animation frame using the latest live phone heading.

Bus icon: 🚌 or an equivalent HUD-style icon.

Focused bus:

- larger icon
- visually highlighted
- information card becomes visible

## Focus System

Use head direction as the primary interaction.
No tapping should be required once the phone is inside Cardboard.

A bus becomes focused when approximately:

```text
abs(offsetDeg) <= 7.5°
```

If multiple buses satisfy this, choose the closest / best centered bus.

Recommended behavior:

```text
look toward bus
    ↓
focus indicator appears
    ↓
hold gaze ~500-1000 ms
    ↓
show details
```

Avoid instant information-card switching if heading noise causes targets to rapidly change.

## Hands-Free Interaction

The MVP does NOT require advanced interaction.
However, design the system so these can be added later.

### Gaze

Look at vehicle to select it.

### Head Tilt

Possible commands:

- tilt left → previous vehicle
- tilt right → next vehicle

### Voice

Possible future queries:

- "How long until this bus reaches Reitz?"
- "Where does this bus go?"
- "Is this bus delayed?"
- "Will this take me to Shands?"

Voice is NOT required before the core AR system works.

## Bus HUD

Display route number, destination, distance and available transit metadata.

Focused bus card:

```text
ROUTE 38

Gainesville Place

Arriving in 2 min

0.2 mi away
18 mph

ON TIME
```

Optional: HALF EMPTY.

## Compass HUD

Preserve the shared compass behavior.

Example:

```text
        W        NW         N

     🚌 9                🚌 38
```

Bus markers along the compass represent real-world bearings.
Use route number as the strongest identifying information.
Use `[🚌 38]` instead of a generic bus icon when space permits.

## Mobile AR Renderer

Mobile AR should reuse the same bus state.

It should:

- use full-screen rear camera
- show one HUD rather than stereo duplication
- use the same bus bearings
- use the same FOV
- use the same focused bus
- show the same information card

This renderer is secondary.
Do not delay Cardboard functionality to perfect mobile UI.

## Demo Mode

REQUIRED.

Use a fixed Gainesville location.
Recommended location: UF / Reitz Union area.

Demo fixture: 8-15 buses.

Examples:

- Route 9
- Route 12
- Route 13
- Route 20
- Route 33
- Route 38

Place buses at intentionally varied bearings.

For example:

- Route 38 → northeast
- Route 9 → east
- Route 12 → southeast
- Route 33 → west

Demo mode should:

- ignore live GPS
- use fixed location
- use local fixture buses
- keep LIVE device orientation
- keep Cardboard rendering functional
- work without RTS network access

The user should be able to physically rotate while wearing Cardboard and see different buses.

## Desktop Development Mode

Preserve desktop dev mode.

Allow:

- keyboard arrow heading adjustment
- heading slider
- demo fixture
- no camera requirement

This should allow development without repeatedly wearing the headset.

## Failure Handling

If RTS API fails, DO NOT crash.

Show: LIVE DATA TEMPORARILY UNAVAILABLE.

If cached data exists, use it.
Demo mode must remain available.

If orientation permission fails, show clear instructions.

If camera permission fails, HUD should still be debuggable over a blank/test background.

## Development Milestones

### Phase 0

Run original project unchanged.

Verify:

- Cardboard
- stereo rendering
- orientation
- demo buses
- compass
- focus behavior

DO NOT MODIFY BEFORE THIS WORKS.

### Phase 1

Create Bus model.
Create Gainesville bus fixture.
Render route-first bus content.
Keep original geographic math.

Goal: Cardboard demo works with fake Gainesville buses.
This is the first major milestone.

### Phase 2

Create bus-service.
Connect Gainesville RTS live API.
Normalize external data into Bus objects.

Goal: `GET /api/buses/nearby` returns live Gainesville vehicles.

### Phase 3

Connect live bus data to AR.

Goal: Real RTS buses appear at their calculated bearings while outdoors.

### Phase 4

Tune real-world alignment.
Test outdoors near UF.

Tune:

- camera FOV
- compass offset
- true/magnetic north correction
- smoothing
- orientation transforms

Goal: Labels appear reasonably close to real bus directions.

### Phase 5

Add Mobile AR mode.
Do this AFTER Cardboard live mode works.

Goal: Same system works without headset.

### Phase 6

Add transit-specific enhancements.

Possible:

- arrivals
- stops
- route colors
- delay information
- occupancy

## Stretch Goal: Bus Stops

Fetch nearby stops.
Bus stops are stationary geographic targets and can use the same projection system.

Example:

```text
          REITZ UNION
          BUS STOP

        9       2 min
        12      5 min
        38      7 min
```

Stop markers should use a different icon from buses.

## Stretch Goal: Arrival Predictions

Use RTS prediction data.

Focused card:

```text
ROUTE 38
Gainesville Place

ARRIVING IN
2 MIN
```

## Stretch Goal: Bus Motion Prediction

RTS positions may update only every few seconds.

Between server updates, estimate bus movement using:

- speed
- heading
- elapsed time

```text
distance = speed × deltaTime
```

Use prediction only for visual smoothing.
When new RTS GPS arrives, correct prediction toward actual location.

## Stretch Goal: Computer Vision

After the geospatial system works, run pretrained bus detection.

```text
Camera
   ↓
YOLO
   ↓
bus bounding boxes
```

Geospatial system separately predicts expected bus screen x-coordinate.
Then match predicted location + visual bus position.
This allows the AR label to snap closer to the actual visible bus.

Do NOT make computer vision a dependency of MVP.

## Stretch Goal: OCR

For visible buses:

1. Detect bus.
2. Crop front destination display.
3. Run OCR.
4. Extract route number.
5. Compare against RTS vehicle candidates.

Example:

```text
camera sees: 38 GAINESVILLE PLACE
OCR: 38
RTS candidate: Route 38
→ high-confidence association
```

## Stretch Goal: Sensor Fusion

Long-term strongest technical version:

```text
RTS GPS
    +
phone GPS
    +
phone orientation
    +
bus motion prediction
    +
computer vision
    +
route OCR
        ↓
fused physical bus identity
        ↓
stable AR overlay
```

Do NOT attempt this until baseline geographic AR works.

## Acceptance Criteria

Cardboard MVP is complete when:

1. App launches on a supported phone.
2. Camera works.
3. Google Cardboard stereo view works.
4. GPS permission works.
5. Orientation permission works.
6. Demo buses appear at correct bearings.
7. Turning the user's head changes bus marker position correctly.
8. Focused buses display route information.
9. Live RTS vehicles can be retrieved.
10. Live buses appear at approximately correct geographic directions.
11. Backend failures do not crash the app.
12. Demo mode works offline.

Mobile AR MVP is complete when:

1. User can select Mobile AR.
2. One full-screen camera feed appears.
3. The same bus tracking state is reused.
4. Bus labels appear at equivalent positions.
5. Focus behavior works.

## Non-Goals

Do NOT prioritize:

- native ARKit
- native ARCore
- SLAM
- 3D world meshes
- custom ML training
- user accounts
- authentication
- social features
- route planning
- payments
- complex backend infrastructure

This project is fundamentally:

```text
LIVE TRANSIT DATA
+
GEOSPATIAL MATH
+
PHONE SENSOR ORIENTATION
+
GOOGLE CARDBOARD
=
AR PUBLIC TRANSIT HUD
```

## Engineering Principles

1. Cardboard first.
2. Mobile AR second.
3. Preserve working orientation code.
4. Preserve existing geographic math.
5. Modify rather than rewrite.
6. Maintain demo mode at all times.
7. API secrets stay server-side.
8. Prefer reliable hackathon behavior over architectural purity.
9. Build stretch goals only after live AR works.
10. Keep Cardboard and Mobile renderers driven by the same underlying state.

## First Codex Task

Before making changes:

1. Inspect the entire repository.
2. Identify the files responsible for camera access, stereo rendering, Cardboard calibration, phone orientation, compass heading, FOV configuration, geographic bearing, distance calculation, screen projection, Bus type, transit HUD rendering, focused bus card, transit API, and demo fixtures.
3. Produce a migration plan.
4. For every relevant file, classify it as KEEP, MODIFY, REPLACE, or REMOVE EVENTUALLY.
5. Do NOT make broad refactors yet.
6. Implement the first milestone: Bus model + Gainesville demo fixture + bus-focused Cardboard HUD, while preserving the existing Cardboard orientation and projection system.

Stop after this milestone and verify the application still works before modifying the live data service.
