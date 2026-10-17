# Street map and compass distance verification

Implementation date: October 16, 2026.
This milestone adds streets and vehicle positions, shared map controls, and an independent compass distance filter.
Gemini, transit route overlays, search, stops, arrivals, and navigation remained planned at this milestone.
The later [transit routes milestone](TRANSIT_ROUTES_VERIFICATION.md) added routes, stops, search, and the focused-route overlay.

## Implementation

`web/src/map-state.ts` defines shared state and validated `set_map_mode` / `set_map_extent` actions.
Extent means center-to-edge distance, initially the feed search radius, bounded to 0.1-400 km.
Mode changes retain extent.
Shared state carries current GPS and the last usable response center separately.
Cached vehicles are rebased to current GPS before compass filtering and dwell selection.

`web/src/street-map.ts` maintains one offscreen MapLibre instance per session, using the documented Vite bundled worker URL and OpenFreeMap dark style.
Road colors and label sizes are tuned for the small HUD.
Its 15 Hz update loop is separate from the camera/compass animation loop, with pixel ratio capped at 2.
Bus overlays use MapLibre's own projection, and radar fallback uses the matching Web Mercator transform.
Reported coordinates are never snapped to roads.
A composite map frame is copied to both eyes and casting.
While new tiles load, the last usable composite remains visible, with its matching extent and orientation caption.
Errors select a labeled radar fallback.
Exit clears the interval, removes the map and its event listeners/workers/WebGL resources, and removes its host.

The HUD suppresses focused cards while expanded and preserves the compass.
Map controls are duplicated per eye and excluded from calibration and long-press handling.
Map-data attribution appears in headset/cast pixels, with linked attribution in the headset DOM.
The native transit renderer uses a bus radar and imports no MapLibre runtime.

## Automated and desktop evidence

- All 12 web tests pass, including exact mile conversion, inclusive boundaries, duplicate route numbers, excluded focus clearing, independent map eligibility, action bounds/mode persistence, Mercator rotation/wraparound/zoom, and GPS rebasing.
- Web production build passes with MapLibre's bundled worker emitted as a separate asset.
The bundler reports a large map-library chunk warning.
- Native Android TypeScript/Vite compatibility build passes.
`npm run apk` builds and syncs assets but cannot package an APK because JDK 21+ is unavailable.
- Chromium displayed actual OpenFreeMap roads and the existing live RTS feed around the explicitly labeled desktop Reitz Union location.
The feed showed 15-18 vehicles during inspection; counts vary with time.
Both compact circular and expanded translucent views were inspected at desktop and 852 × 393 CSS-pixel viewports.
Road brightness and label size were increased after visual inspection.
- Browser checks confirmed two consistent Map/Close buttons, manual zoom, Escape closing the map while retaining the running view, and a second Escape returning to settings.
The two eye HUD canvases produced identical PNG data in the same frame.
Exit removed the map host; restart created exactly one map canvas.
- Blocking the OpenFreeMap requests kept the view running with radar fallback.
Forcing both WebGL context types to return null also kept compass, map controls, and radar running with an explicit road-map-unavailable label.

- An isolated browser comparison of the fallback transform against MapLibre's `project` covered headings 0, 1, 90, 180, 359, and 360 at extents 0.1, 5, and 400 km.
Maximum difference was below 0.000001 pixel.
- A local WebRTC viewer received a 960 × 720 live stream with compact streets/buses/attribution and the expanded map after the publisher toggled M.
The publisher remained foregrounded, matching the inherited browser casting requirement.
- Browser permission harnesses verified a location fix with no heading produces the explicit north-up map, and GPS denial produces location status without constructing a map at an unrelated center.

## Physical acceptance

The handoff records the user's earlier successful location test on iPhone 16 Pro over HTTPS.
That report establishes location permission/fix only, not compass correctness, headset fusion, or this new map's acceptance.
A new stationary handheld iPhone test has been requested for roads/live vehicles, Map/Close in both eyes, and independent compass-distance behavior.
Its result remains pending until the user reports it.

Pending physical checks include map readability and transparency over the actual camera, rotation/zoom alignment, compass calibration, both landscape orientations, headset fusion, outdoor dwell, background/foreground recovery, resource cleanup on Safari, and phone-to-laptop casting.
No physical compass or headset alignment is claimed.

## Provider references

The implementation follows [MapLibre's Vite worker setup](https://maplibre.org/maplibre-gl-js/docs/#installation), [OpenFreeMap setup](https://openfreemap.org/quick_start/), and its [published dark style](https://github.com/hyperknot/openfreemap-styles).
The feed API, server credentials, and voice provider are unchanged.
