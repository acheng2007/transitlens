# TransitLens bus service

Server-side Gainesville RTS BusTime adapter on port 8003.
The browser receives normalized vehicles and never receives the RTS key.

```sh
cd bus-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Put your key in .env, then run:
uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8003
```

Use a single worker so all clients share one cache and refresh lock.
The ignored `.env` file is for local development only.
Set environment variables directly in deployment.
Keep HTTP client debug logging disabled because upstream request URLs contain the key.
Do not expose this development server directly to the public Internet.

`GET /api/buses/nearby?lat=29.6465&lon=-82.3478&radiusKm=5&fovDeg=360`
returns `center`, `demo: false`, nullable `fetchedAt`, `status`, `magneticDeclinationDeg`, and `buses` using [the shared contract](../shared/transit.ts).
`heading` is optional in [0, 360), clockwise from true north.
Radius defaults to 5 km; FOV defaults to 360 degrees.
The web app requests all bearings and projects them each frame.

The service caches the route list used for vehicle batches for one hour and complete vehicle snapshots for at least 30 seconds.
Both intervals are configurable through `.env.example`.
Each upstream request has an eight-second timeout; vehicle calls contain at most ten route IDs.
Requests share one refresh, and failed refreshes retain the last complete successful snapshot.
`available` includes successful empty results; `stale` means the previous snapshot remains after a failed refresh; `unavailable` means no successful snapshot exists.
Cache contents are in memory and reset when the service restarts.

The [Gainesville-hosted BusTime v3 guide](https://riderts.app/bustime/apidoc/docs/DeveloperAPIGuide3_0.pdf) documents speeds in mph, WGS84 coordinates, occupancy values, ten-route batches, and a default allowance of 10,000 requests per key per day.
The effective snapshot interval increases when the number of route batches would exceed `RTS_DAILY_REQUEST_LIMIT`, after reserving catalog calls.
Use a separate key or account for traffic from other applications sharing the same key.
The guide does not guarantee vehicle observation cadence; `fetchedAt` is our last successful retrieval time, not proof that every vehicle position was measured at that instant.
Missing delay remains null; even explicit false is displayed as “NO DELAY REPORTED”, rather than an arrival or punctuality guarantee.

True-north correction uses pygeomag with WMM2025 coefficients, the requested position, current UTC date, and sea-level altitude.
[NOAA documents the model and its validity period](https://www.ncei.noaa.gov/products/world-magnetic-model).
Outside the supported model dates, correction is null and the web app explicitly labels its uncorrected magnetic heading rather than using Atlanta's inherited value.
Local magnetic interference and physical phone alignment still require outdoor testing.

Each vehicle also includes nullable `patternId`, the RTS pattern (`pid`) it is currently executing.
The web app uses it to draw the focused bus's route on the minimap.

## Transit routes, stops, and direct service

These endpoints give TransitLens and the Gemini voice service authoritative route geometry, stops, and direct-route answers.
They are deterministic: no model is involved, and every result comes from RTS data.
Voice-service should call them as tools rather than inferring service from route names or destination strings.
Response types are defined in [shared/transit.ts](../shared/transit.ts).

### Data source and caching

`app/transit.py` loads `getroutes` once and then `getpatterns?rt=` for every route, through the same server-only `RTS.request` path used for vehicles.
Responses observed from Gainesville on October 16, 2026 matched the BusTime v3 guide: patterns contain `pid`, `ln` in feet, `rtdir`, and ordered `pt` points with `typ` (`S` for stop, `W` for waypoint), `stpid`, `stpnm`, and `pdist` in feet.
Stops are derived from pattern stop points, so no `getstops` call is needed.
Each stop lists every route, direction, and pattern that serves it.
Stop IDs stay strings because Gainesville uses leading zeros, such as `0473`.
Feet are converted to kilometers explicitly.
Detour patterns (`dtrid`) are kept as their own patterns with `detour: true`.
Route colors are accepted only as `#rrggbb`; anything else becomes `null`.

The catalog is cached in memory for `RTS_CATALOG_TTL_SECONDS` (default 86400, one day) and loads on first use, taking about two seconds with 27 routes.
A failed refresh keeps the last good catalog and reports `stale`.
After a failure, the service waits at least five minutes before retrying, so an outage or missing key cannot spend the request budget.
`getpatterns?rt=` returns only default and currently active patterns.
If a live vehicle reports a pattern that is not cached, `/api/transit/patterns/{id}` fetches it once by `pid`.
Pattern IDs that no live vehicle reports are never fetched, and a failed on-demand lookup is not retried for ten minutes.

The catalog declares its daily upstream calls to the vehicle client: one route call plus one pattern call per route per refresh, plus 300 reserved on-demand lookups.
The vehicle snapshot interval subtracts these from `RTS_DAILY_REQUEST_LIMIT` before spreading vehicle batches across the day.
With the defaults this catalog reserves about 330 calls per day out of 10,000.
The companion copilot catalog and predictions reserve additional calls through the same vehicle client, and every actual upstream call also counts toward its hard daily cap.

### Envelope and errors

Every response includes `status` (`available`, `stale`, or `unavailable`) and `fetchedAt`, the last successful catalog retrieval time.
List endpoints return HTTP 200 with `status: unavailable` and empty lists when no catalog has ever loaded.
Lookups by ID and direct-service queries return HTTP 503 in that case, so missing data is never reported as an unknown ID.
Unknown route, pattern, or stop IDs return 404.
Invalid parameters, including IDs outside `[A-Za-z0-9_.-]`, return 422.

### Endpoints

`GET /api/transit/routes` returns every route with `id`, rider-facing `display` number, `name`, `color`, and its `directions`.

`GET /api/transit/routes/{routeId}` returns that route with its `patterns`.
Each pattern has `direction`, `lengthKm`, `detour`, ordered `points` as `[lat, lon]`, and ordered `stops` with `sequence` and `distanceKm` along the pattern.

`GET /api/transit/patterns/{patternId}` returns one pattern plus `routeDisplay`, `routeName`, and `routeColor`.
The minimap overlay uses this endpoint.

`GET /api/transit/stops/nearby?lat=&lon=&radiusKm=0.8&limit=20` returns stops sorted by straight-line distance, each with `distanceKm`, `bearingDeg`, and the routes and directions serving it.
`radiusKm` is at most 5 and `limit` at most 50.

`GET /api/transit/stops/search?q=&limit=10` matches every word of `q` against stop names, ignoring case and punctuation.
Exact names rank first, then names that start with the query.
It returns all candidates instead of choosing one, so the assistant can ask a short clarifying question when several stops match, such as the six "Shands" stops.

`GET /api/transit/direct` answers "which routes go from here to there" for direct trips only.
Give exactly one origin, either `fromStopId` or `fromLat` and `fromLon`, and exactly one destination, either `toStopId` or `toLat` and `toLon`.
Coordinates consider every stop within `radiusKm` (default 0.8, at most 2).
A pattern qualifies when it reaches a destination stop after an origin stop, so opposite directions and stops already passed are excluded.
The best option per route and direction is kept, ranked by total straight-line distance to the boarding stop and from the drop-off stop, then by ride distance.
`limit` defaults to 5 and is at most 10.

Each option contains the route, direction, `patternId`, `detour`, `boardStop`, `alightStop`, `stopsBetween`, `rideKm`, and `activeVehicleCount`.
`activeVehicleCount` counts live vehicles currently reporting that route and direction; it is not an arrival prediction.
When the origin is given as coordinates, `approachToBoarding` gives the straight-line distance and bearing to the boarding stop.
When the destination is given as coordinates, `alightingToDestination` does the same from the drop-off stop.
Both carry `note: "approximate direction, not a walking route"` and must never be presented as a walkable path.
The response is labeled `coverage: "direct-service"` and lists its `limitations`: transfers are not considered, coverage is not a live arrival or proof a bus is running now, distances are straight-line, and only default and active patterns are included.

Example: Reitz Union to Shands Children's Hospital.

```sh
curl 'http://127.0.0.1:8003/api/transit/direct?fromLat=29.6465&fromLon=-82.3478&toStopId=0664'
```

On October 16, 2026 this returned routes 43 inbound and 17 outbound from University Police Department, three stops and 0.62 km of riding, with an approximate 0.47 km approach at bearing 121 degrees.

### Not included

These `/api/transit` endpoints do not provide place-name geocoding beyond stop-name search, arrival predictions, transfer journeys, or pedestrian routing.
The companion `/api/buses/plan` endpoint described below adds available arrival predictions for copilot trips.
Turn-by-turn walking guidance needs a verified pedestrian routing source before it can be added.

## Tests

```sh
python -m unittest discover -s tests -v
```

## Route discovery and arrivals

The companion `/api/buses/stop-distance` and `/api/buses/route-details` endpoints support bus-to-stop queries and route/next-stop descriptions.
The planner accepts `onboardBusId` and supplies matched vehicles and a recommendation grounded in current service evidence.
See [natural routing](../docs/NATURAL_ROUTING.md) for parameters, distance semantics, conservative progress matching, and limitations.

`GET /api/buses/network?demo=false` returns normalized ordered RTS patterns, shapes and stops.
The catalog is cached for an hour, including partial snapshots, so unavailable patterns do not cause a request storm.
A failed refresh retains stale patterns with an explicit status.
A background warmup prepares the catalog when the server has an RTS key.

`GET /api/buses/plan?destination=Shands&lat=29.6465&lon=-82.3478&demo=false` resolves actual stop names and checks boarding/alighting order on each pattern.
Stops more than 0.7 km apart under the same search name require a specific stop choice.
The initial direct planner limits boarding stops to 0.8 km straight-line distance.
It does not compute walking routes or transfers, and a pattern is not a timetable guarantee.
The first three options query matching stop/route/direction predictions through a 30-second cache.
A missing prediction stays unknown; active vehicle count is separate from arrival time.

Set `demo=true` explicitly to use the captured six-route fixture, synthetic vehicles and scripted arrival values.
Demo does not use the RTS credential and is never a fallback for a live outage.
The shared fixture contains public route geometry only, without credentials.
All upstream calls share the instance request counter and daily cap, including patterns and predictions.
Use a single service worker; multiple workers, restarts or other applications sharing a key require a coordinated persistent budget for strict account-wide enforcement.

Provider reference: [BusTime v3 guide](https://riderts.app/bustime/apidoc/docs/DeveloperAPIGuide3_0.pdf).

`tests/test_service.py` uses mocked upstream responses for batches, normalization, missing fields, duplicate IDs, empty results, errors, timeout, stale cache, recovery, radius boundaries, FOV, and heading wraparound.
`tests/test_transit.py` covers pattern ordering, feet-to-kilometer conversion, invalid points, detours, color validation, stops shared across routes and directions, direction-aware direct service, ranking, stop search, catalog failure and retry backoff, on-demand pattern lookups, budget reservation, endpoint validation, and unavailable-catalog behavior.
