"""flight-service: GET /api/flights/nearby (see root CLAUDE.md for the contract)."""
import logging
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query

from . import adsb, demo
from .geo import in_cone
from .normalize import normalize

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("flight-service")

DEFAULT_RADIUS_KM = 15  # ~9.3 miles
KM_PER_NM = 1.852

app = FastAPI(title="flight-service")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_planes(
    raw: list[dict],
    lat: float,
    lon: float,
    radius_km: float,
    heading: float | None,
    fov_deg: float,
) -> list[dict]:
    """Normalize, drop out-of-radius / out-of-cone planes, sort by distance."""
    planes = []
    seen = set()
    for ac in raw:
        p = normalize(ac, lat, lon)
        if p is None or p["id"] in seen or p["distanceKm"] > radius_km:
            continue
        if heading is not None and not in_cone(p["bearingDeg"], heading, fov_deg):
            continue
        seen.add(p["id"])
        planes.append(p)
    planes.sort(key=lambda p: p["distanceKm"])
    return planes


def apply_routes(planes: list[dict], routes: dict) -> None:
    for p in planes:
        route = routes.get(p["callsign"]) if p["callsign"] else None
        if route:
            p["origin"], p["destination"] = route[0], route[1]


@app.get("/api/flights/nearby")
async def nearby(
    lat: float | None = Query(None, ge=-90, le=90),
    lon: float | None = Query(None, ge=-180, le=180),
    radiusKm: float | None = Query(None, gt=0, le=400),
    heading: float | None = Query(None, description="True-north degrees; if set, only planes in the view cone"),
    fovDeg: float = Query(30.0, gt=0, le=360, description="Total cone width in degrees"),
    demo_: int = Query(0, alias="demo", ge=0, le=1),
):
    if heading is not None:
        heading %= 360.0

    if demo_:
        lat, lon = demo.DEMO_LAT, demo.DEMO_LON
        radius_km = radiusKm or demo.DEMO_RADIUS_KM
        snap = demo.load_snapshot()
        planes = build_planes(snap.get("ac", []), lat, lon, radius_km, heading, fovDeg)
        apply_routes(planes, snap.get("routes", {}))
        fetched_at = snap.get("capturedAt") or _now_iso()
    else:
        if lat is None or lon is None:
            raise HTTPException(status_code=422, detail="lat and lon are required unless demo=1")
        radius_km = radiusKm or DEFAULT_RADIUS_KM
        raw = await adsb.fetch_point(lat, lon, radius_km / KM_PER_NM + 1)  # +1 nm margin, trimmed by km below
        planes = build_planes(raw, lat, lon, radius_km, heading, fovDeg)
        try:
            apply_routes(planes, await adsb.fetch_routes(planes))
        except Exception as e:
            log.warning("route enrichment failed: %s", e)
        fetched_at = _now_iso()

    return {
        "center": {"lat": lat, "lon": lon},
        "demo": bool(demo_),
        "fetchedAt": fetched_at,
        "planes": planes,
    }
