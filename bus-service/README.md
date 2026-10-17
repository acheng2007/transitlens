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

The service caches the route catalog for one hour and complete vehicle snapshots for at least 30 seconds.
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

```sh
python -m unittest discover -s tests -v
```

Tests use mocked upstream responses for batches, normalization, missing fields, duplicate IDs, empty results, errors, timeout, stale cache, recovery, radius boundaries, FOV, and heading wraparound.
