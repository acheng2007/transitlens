"""Capture a frozen demo snapshot around Georgia Tech from live adsb.lol data.

Writes:
  flight-service/data/demo-snapshot.json  (raw readsb aircraft + routes; used by demo=1)
  shared/fixtures/demo-planes.json        (normalized contract response for the web app)

Usage (from flight-service/):  python scripts/capture_snapshot.py [radiusKm]
"""
import asyncio
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import adsb, demo  # noqa: E402
from app.main import KM_PER_NM, apply_routes, build_planes  # noqa: E402

FIXTURE_PATH = ROOT.parent / "shared" / "fixtures" / "demo-planes.json"


async def main() -> None:
    radius_km = float(sys.argv[1]) if len(sys.argv) > 1 else demo.DEMO_RADIUS_KM
    lat, lon = demo.DEMO_LAT, demo.DEMO_LON

    raw = await adsb.fetch_point(lat, lon, radius_km / KM_PER_NM + 1)
    if not raw:
        sys.exit("No aircraft returned from adsb.lol; not overwriting snapshot.")
    planes = build_planes(raw, lat, lon, radius_km, None, 360)

    routes: dict = {}
    for i in range(0, len(planes), 50):
        routes.update(await adsb.fetch_routes(planes[i : i + 50]))
    routes = {cs: list(r) for cs, r in routes.items() if r[0] or r[1]}
    apply_routes(planes, routes)

    captured_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    snapshot = {
        "capturedAt": captured_at,
        "center": {"lat": lat, "lon": lon},
        "radiusKm": radius_km,
        "ac": raw,
        "routes": routes,
    }
    demo.SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    demo.SNAPSHOT_PATH.write_text(json.dumps(snapshot, indent=1), encoding="utf-8")

    fixture = {
        "center": {"lat": lat, "lon": lon},
        "demo": True,
        "fetchedAt": captured_at,
        "planes": planes,
    }
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")

    # Coverage report: how evenly planes surround the demo location (8 x 45-degree sectors).
    sectors = Counter(int(p["bearingDeg"] // 45) for p in planes)
    names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    print(f"{len(planes)} planes within {radius_km} km, {len(routes)} with routes")
    print("  ".join(f"{names[i]}:{sectors.get(i, 0)}" for i in range(8)))
    print(f"wrote {demo.SNAPSHOT_PATH}\nwrote {FIXTURE_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
