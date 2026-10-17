# flight-service/ — owner: Wesley

Python FastAPI service on port 8001. Serves `GET /api/flights/nearby` per root `CLAUDE.md`.

## Run

```sh
cd flight-service
python -m venv .venv
.venv/Scripts/activate        # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
uvicorn app.main:app --port 8001 --reload
```

## API

`GET /api/flights/nearby?lat=&lon=&radiusKm=&heading=&fovDeg=30&demo=0|1`

| Param | Default | Notes |
|---|---|---|
| `lat`, `lon` | required unless `demo=1` | user position |
| `radiusKm` | 15 (~9.3 mi); 40 in demo | The web app never sends it, so these defaults apply |
| `heading` | none | true-north degrees. If set, only planes inside the view cone are returned |
| `fovDeg` | 30 | total cone width (in cone if `abs(diff) <= fovDeg/2`) |
| `demo` | 0 | 1 = pinned to Georgia Tech + frozen snapshot (`data/demo-snapshot.json`), no network |

Returns the contract shape `{ center, demo, fetchedAt, planes: Plane[] }`, with `planes` sorted by `distanceKm`.
Never 500s on upstream failure (it falls back to the last cached result, or an empty list).

```sh
curl "localhost:8001/api/flights/nearby?demo=1&heading=180"
curl "localhost:8001/api/flights/nearby?lat=33.7756&lon=-84.3963&heading=180"
```

## Data sources

- Positions: `https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}` (cached 1 s, matching the web app's 1 s polling). adsb.lol returns 429 at this rate, so the query center is snapped to a ~1 km grid (GPS jitter reuses the cache), a 429 triggers a `Retry-After` backoff (default 5 s), and failures serve the most recent good data instead of an empty list. Requires a non-default User-Agent (adsb.lol 403s `python-httpx`).
- Routes: `POST https://adsb.im/api/0/routeset` (the `api.adsb.lol` mirror currently returns empty responses). Cached per callsign for 30 min. Only `plausible` routes are used. For multi-leg routes, the leg the plane is currently flying is chosen by position.
- `typeName` and `airline` come from small lookup tables in `app/normalize.py`.
- Status fields, also in `app/normalize.py`:
  - `kind`: `'helicopter'` if ADS-B category `A7` or a known helicopter type code, else `'plane'`.
  - `onGround`: `alt_baro == "ground"`.
  - `emergency`: readsb `emergency` status (`general`, `minfuel`, `nordo`, `unlawful`, `downed`), else from squawk 7500/7600/7700; `null` if none.
  - `military`: adsb.lol `dbFlags` bit 1.
  - `medical`: `emergency == "lifeguard"` (medical-priority flight, **not** reported as an emergency) or an air-ambulance callsign prefix (`GRDIAN`, `LIFE`, `MEDEVAC`, ...). There's no reliable ADS-B medical flag, so this is best-effort.

## Test scripts

```sh
python scripts/sanity_check.py                  # offline: notional planes, asserts geo/cone/sort/contract (no server, no network)
python scripts/live_check.py --heading 180      # calls the running service and prints a table + contract checks
python scripts/live_check.py --heading 180 --watch 3   # poll every 3 s
python scripts/live_check.py --sweep            # plane count per 30-degree cone, all the way around
python scripts/live_check.py --demo --heading 190
```

`live_check.py` defaults to `http://127.0.0.1:8001`. On Windows, `localhost` adds about 2 s per request (IPv6 is tried first).

## Refresh the demo snapshot

```sh
python scripts/capture_snapshot.py [radiusKm]   # default 40
```

This writes `data/demo-snapshot.json` (raw data + routes) and `shared/fixtures/demo-planes.json` (the normalized response for the web app), then prints how many planes fall in each 45° sector.
