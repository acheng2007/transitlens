"""Demo mode: fixed location (Georgia Tech) + frozen raw adsb.lol snapshot.

The snapshot is raw readsb data so it runs through the same normalize/cone pipeline
as live data. Routes are stored alongside so demo mode never touches the network.
Regenerate with `python scripts/capture_snapshot.py`.
"""
import json
from functools import lru_cache
from pathlib import Path

DEMO_LAT = 33.7756
DEMO_LON = -84.3963
DEMO_RADIUS_KM = 40.0  # wider than live so planes surround the room in 360 degrees

SNAPSHOT_PATH = Path(__file__).resolve().parent.parent / "data" / "demo-snapshot.json"


@lru_cache(maxsize=1)
def load_snapshot() -> dict:
    """{capturedAt, center, ac: [raw readsb], routes: {callsign: [origin, destination]}}"""
    try:
        return json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"capturedAt": None, "ac": [], "routes": {}}
