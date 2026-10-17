# Transit routes, stops, and route overlay verification

Implementation date: October 16, 2026.
This milestone adds authoritative RTS route patterns and stops to bus-service, deterministic query endpoints for route discovery, and the focused bus's route on the shared minimap.
It is workstream B's first assignment in [the parallel work plan](PARALLEL_WORK.md), plus the first route overlay from workstream E.
Gemini, voice-service, place geocoding, arrivals, transfer journeys, pedestrian routing, and guidance UI are not part of this change.

## Why this milestone

Every remaining copilot feature needs route geometry, directions, and stops from a trusted source.
Examples include "Show me all routes that go to Reitz Union", "Highlight route 38", and guidance to a boarding stop.
The Gemini voice service is being built separately, so these endpoints are designed to be called directly as its tools.
Gemini interprets the request; bus-service computes the transit answer deterministically.

## Backend implementation

`bus-service/app/transit.py` adds `TransitCatalog`.
It calls `getroutes` once and `getpatterns?rt=` for each route through the existing server-only `RTS.request` path.
The key, upstream error handling, and credential-safe logging therefore stay in one place.

Live responses confirmed the documented BusTime v3 fields before the code relied on them.
Gainesville returned 27 routes with `rt`, `rtnm`, `rtclr`, and `rtdd`.
Route 38 returned one looping pattern, `593` `INBOUND`, with 166 points and 21 stops.
Stop IDs use leading zeros, pattern IDs are integers, and every vehicle reports its current `pid`.

Normalization decisions:

- Points are sorted by `seq`, and invalid or null-island positions are dropped.
- Stops come from `typ: S` points, with a zero-based `sequence` and `distanceKm` along the pattern.
- `ln` and `pdist` are converted from feet with an explicit 0.0003048 km per foot.
- Patterns with `dtrid` are flagged `detour: true`.
- Route colors must match `#rrggbb`, otherwise they become `null`.
- All IDs stay strings.
- Vehicles gain nullable `patternId` from `pid`.

The catalog caches for one day by default (`RTS_CATALOG_TTL_SECONDS`).
A failed refresh keeps the last good data as `stale`, and retries wait at least five minutes.
Unknown patterns are fetched by `pid` only when a live vehicle reports them, at most once per ten minutes per ID.
The catalog reserves its daily calls from the vehicle budget, about 330 of the default 10,000.

`bus-service/app/main.py` adds six endpoints under `/api/transit`: routes, route detail, pattern, nearby stops, stop search, and direct service.
The [bus-service README](../bus-service/README.md#transit-routes-stops-and-direct-service) documents every parameter, field, error, and limitation.

The direct-service endpoint accepts a stop ID or coordinates at each end.
It keeps the best option per route and direction where a pattern reaches a destination stop after an origin stop.
Options are ranked by straight-line walking distance, then ride distance.
Each option includes the boarding and drop-off stops, stop count, ride distance, and the number of live vehicles on that route and direction.
Coordinate inputs add a straight-line distance and bearing labeled "approximate direction, not a walking route".
The response is labeled direct-service coverage and lists its limitations, so callers cannot present it as an arrival time, a transfer plan, or a walking route.

## Shared contract

`shared/transit.ts` adds `TransitRoute`, `TransitPattern`, `PatternStop`, `TransitStop`, `NearbyStop`, `StopRef`, `ApproximateLeg`, `DirectServiceOption`, `DirectServiceEndpoint`, and a response type for each endpoint.
`Bus.patternId` is optional and nullable, so existing fixtures and other branches keep compiling.
These types are the agreed interface for the Gemini developer's tool definitions.

## Web implementation

`web/src/transit-data.ts` adds a pattern cache and a route selection.
The cache fetches each pattern ID once per session with no polling, retries failures after 60 seconds, validates every response, ignores mismatched IDs, holds at most 64 patterns, and aborts outstanding requests on exit.
The selection follows the shared focused bus, which is still computed once per frame.
It keeps the last route for three seconds after focus is lost so heading jitter does not flicker it.
A newly focused bus without a pattern clears the route immediately, so the map never shows another bus's route.

`web/src/route-overlay.ts` draws the pattern line with a dark casing in the route color, falling back to the HUD focus color.
Detours are dashed.
Stop dots are skipped when they would overlap the previous dot, so wide zooms stay readable.

`web/src/street-map.ts` draws the overlay before bus markers, using the same projection as the markers: MapLibre when roads are available, otherwise the matching Web Mercator radar fallback.
Both eyes and casting copy the single composite map frame, so the route stays identical everywhere.
`web/src/main.ts` adds only the cache lifecycle and two per-frame lines.
New logic lives in new files to limit merge conflicts with the open `work/frontend-polish` and `work/light-redesign` branches.
`web/vite.config.ts` proxies `/api/transit` to bus-service on port 8003.

## Automated evidence

- All 27 bus-service tests pass, including 17 new transit tests.
- The new tests cover normalization, unit conversion, detours, color validation, shared stops, opposite directions, ordering, ranking, search, catalog failure and backoff, on-demand lookups, budget reservation, validation, and unavailable-catalog responses.
- All 16 web tests pass, including 4 new tests for pattern parsing, unsafe color rejection, cache retry and shutdown, mismatched responses, and route selection hold and clearing.
- The web TypeScript and production builds pass.
- The Android TypeScript/Vite compatibility build passes with the extended shared contract.

## Live and desktop evidence

A bus-service instance on a spare port used the real RTS key without printing it.
The catalog loaded 27 routes in about two seconds.
The stop nearest Reitz Union, `0473` Reitz Union @ McCarty Dr, listed eight serving route directions.
Searching "shands" returned six candidate stops rather than one guess.
Reitz Union coordinates to Shands Children's Hospital (`0664`) returned routes 43 and 17 from University Police Department, three stops and 0.62 km of riding, with an approximate 0.47 km approach at bearing 121 degrees.
Unknown IDs returned 404, malformed IDs and conflicting parameters returned 422, and identical origin and destination returned no options.

Headless Chrome drove the desktop app at `?dev=1&camera=off` through an isolated Vite instance, leaving the regular development servers untouched.
Turning toward a live route 9 bus focused it, requested `/api/transit/patterns/596` exactly once, and drew its line in route 9's color under the bus markers.
The line matched the pattern's real extent, 3.7 km south from Reitz Union to Hunters Run, on the heading-up map.
The two eye canvases were pixel-identical.
The compact, expanded, and zoomed maps all aligned the line with the streets.
After the bus left the view, the route rotated with the heading, stayed for the three-second hold, and then cleared.
Overlapping stop dots at the 5 km extent were fixed after visual inspection.
The only browser error was a missing favicon that predates this change.

## Phone check

On October 16, 2026, the route overlay was checked on a phone over an HTTPS Cloudflare tunnel to the local Vite server.
The updated bus-service on port 8003 supplied live RTS routes and patterns.
The user reported that focusing a bus showed the route overlay and that the behavior looked fine.
This confirms handheld phone rendering of the focused-route overlay with live data.
It does not certify Cardboard fusion, outdoor geographic alignment, Android Chrome, or phone-to-laptop casting.

## Pending acceptance

Cardboard readability, Android Chrome, outdoor geographic alignment, and phone-to-laptop casting checks of the route overlay remain pending.
Transit tool calls from Gemini depend on the separate voice-service work.
Seasonal or inactive patterns that RTS does not return as default or active are not included until a vehicle reports them.
