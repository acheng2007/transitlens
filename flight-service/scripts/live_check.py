"""Call the running flight-service in real time and print what it returns.

Start the service first:  uvicorn app.main:app --port 8001
Then (from flight-service/):
  python scripts/live_check.py                          # all planes within 10 mi of Georgia Tech
  python scripts/live_check.py --heading 180            # only planes in the 30-degree cone facing south
  python scripts/live_check.py --heading 180 --watch 3  # refresh every 3 s (Ctrl+C to stop)
  python scripts/live_check.py --sweep                  # rotate heading 0..330 and count planes per cone
  python scripts/live_check.py --demo --heading 190     # demo snapshot instead of live data
  python scripts/live_check.py --lat 40.64 --lon -73.78 # somewhere else (JFK)

Each response is also checked against the contract (keys, sort order, cone, and
bearing/distance recomputed locally). Exits non-zero if any check fails.
"""
import argparse
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.geo import angle_diff, bearing_deg, haversine_km  # noqa: E402

PLANE_KEYS = {
    "id", "callsign", "registration", "typeCode", "typeName", "airline", "origin", "destination",
    "lat", "lon", "altitudeFt", "groundSpeedKt", "trackDeg", "verticalRateFpm", "distanceKm", "bearingDeg",
}


def fetch(args, heading: float | None) -> tuple[dict, float]:
    params = {"lat": args.lat, "lon": args.lon, "fovDeg": args.fov, "demo": int(args.demo)}
    if args.radius is not None:
        params["radiusKm"] = args.radius
    if heading is not None:
        params["heading"] = heading
    t0 = time.perf_counter()
    r = httpx.get(args.url, params=params, timeout=15)
    ms = (time.perf_counter() - t0) * 1000
    r.raise_for_status()
    return r.json(), ms


def validate(body: dict, heading: float | None, fov: float) -> list[str]:
    errors = []
    if set(body) != {"center", "demo", "fetchedAt", "planes"}:
        errors.append(f"response keys {sorted(body)}")
    planes = body.get("planes", [])
    c = body.get("center", {})
    dists = [p["distanceKm"] for p in planes]
    if dists != sorted(dists):
        errors.append("planes not sorted by distanceKm")
    for p in planes:
        tag = p.get("callsign") or p.get("id")
        if set(p) != PLANE_KEYS:
            errors.append(f"{tag}: keys differ from contract: {sorted(set(p) ^ PLANE_KEYS)}")
        if not 0 <= p["bearingDeg"] < 360:
            errors.append(f"{tag}: bearing {p['bearingDeg']} out of [0,360)")
        b = bearing_deg(c["lat"], c["lon"], p["lat"], p["lon"])
        d = haversine_km(c["lat"], c["lon"], p["lat"], p["lon"])
        if abs(angle_diff(b, p["bearingDeg"])) > 0.1 or abs(d - p["distanceKm"]) > 0.01:
            errors.append(f"{tag}: bearing/distance mismatch (got {p['bearingDeg']}/{p['distanceKm']}, "
                          f"expected {b:.2f}/{d:.3f})")
        if heading is not None and abs(angle_diff(p["bearingDeg"], heading)) > fov / 2 + 1e-9:
            errors.append(f"{tag}: bearing {p['bearingDeg']} outside cone at heading {heading}")
    return errors


def fmt(v, spec: str = "") -> str:
    return "-" if v is None else format(v, spec)


def print_table(body: dict, heading: float | None, ms: float) -> None:
    planes = body["planes"]
    cone = f"heading {heading:g} deg" if heading is not None else "no cone (all directions)"
    print(f"\n{body['fetchedAt']}  demo={body['demo']}  center={body['center']}  {cone}  "
          f"-> {len(planes)} planes in {ms:.0f} ms")
    if not planes:
        return
    print(f"{'callsign':<9} {'type':<24} {'airline':<18} {'route':<11} {'dist km':>7} {'brg':>6} "
          f"{'off':>6} {'alt ft':>7} {'gs kt':>6}")
    for p in planes:
        route = f"{p['origin'] or '?'}-{p['destination'] or '?'}" if (p["origin"] or p["destination"]) else "-"
        off = fmt(angle_diff(p["bearingDeg"], heading), "+.1f") if heading is not None else "-"
        print(f"{fmt(p['callsign'] or p['registration'] or p['id']):<9} "
              f"{fmt(p['typeName'] or p['typeCode'])[:24]:<24} {fmt(p['airline'])[:18]:<18} {route:<11} "
              f"{p['distanceKm']:>7.2f} {p['bearingDeg']:>6.1f} {off:>6} "
              f"{fmt(p['altitudeFt'], '.0f'):>7} {fmt(p['groundSpeedKt'], '.0f'):>6}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8001/api/flights/nearby")
    ap.add_argument("--lat", type=float, default=33.7756)
    ap.add_argument("--lon", type=float, default=-84.3963)
    ap.add_argument("--heading", type=float, default=None)
    ap.add_argument("--fov", type=float, default=30.0)
    ap.add_argument("--radius", type=float, default=None, help="radiusKm (service default: 16.09 live, 40 demo)")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--watch", type=float, default=0, metavar="SECONDS", help="poll repeatedly")
    ap.add_argument("--sweep", action="store_true", help="count planes per cone for headings 0..330")
    args = ap.parse_args()

    try:
        if args.sweep:
            print(f"{'heading':>7}  planes  nearest")
            bad = 0
            for h in range(0, 360, int(args.fov)):
                body, _ = fetch(args, h)
                bad += len(validate(body, h, args.fov))
                ps = body["planes"]
                nearest = f"{ps[0]['callsign'] or ps[0]['id']} @ {ps[0]['distanceKm']:.1f} km" if ps else ""
                print(f"{h:>7}  {len(ps):>6}  {'#' * len(ps):<20} {nearest}")
            print(f"\ncontract checks: {'OK' if not bad else f'{bad} FAILED'}")
            return 1 if bad else 0

        while True:
            body, ms = fetch(args, args.heading)
            print_table(body, args.heading, ms)
            errors = validate(body, args.heading, args.fov)
            print("contract checks: OK" if not errors else "contract checks FAILED:\n  " + "\n  ".join(errors))
            if not args.watch:
                return 1 if errors else 0
            time.sleep(args.watch)
    except httpx.ConnectError:
        print(f"Could not connect to {args.url}. Is the service running?  uvicorn app.main:app --port 8001")
        return 2
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
