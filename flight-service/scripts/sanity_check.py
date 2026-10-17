"""Offline sanity check with notional data. No network, no running server needed.

Places fake aircraft at known bearings/distances around a center point, runs them
through the real pipeline (normalize -> radius -> cone -> sort -> routes) via the
FastAPI app with adsb.lol stubbed out, and asserts the results.

Usage (from flight-service/):  python scripts/sanity_check.py
"""
import asyncio
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import adsb  # noqa: E402
from app.geo import angle_diff, bearing_deg, haversine_km, in_cone  # noqa: E402
from app.main import app  # noqa: E402

CENTER = (33.7756, -84.3963)  # Georgia Tech
PLANE_KEYS = {
    "id", "callsign", "registration", "typeCode", "typeName", "airline", "origin", "destination",
    "lat", "lon", "altitudeFt", "groundSpeedKt", "trackDeg", "verticalRateFpm", "distanceKm", "bearingDeg",
    "category", "kind", "onGround", "emergency", "military", "medical",
}


def offset(lat: float, lon: float, bearing: float, dist_km: float) -> tuple[float, float]:
    """Destination point given start, bearing (deg) and distance (km)."""
    r = 6371.0088
    p1, l1, b, d = math.radians(lat), math.radians(lon), math.radians(bearing), dist_km / r
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def fake_ac(hex_: str, flight: str | None, bearing: float, dist_km: float, **extra) -> dict:
    lat, lon = offset(*CENTER, bearing, dist_km)
    ac = {"hex": hex_, "lat": lat, "lon": lon, "alt_baro": 5000, "gs": 250.0, "track": 90.0, "t": "B738"}
    if flight is not None:
        ac["flight"] = f"{flight:<8}"  # readsb pads callsigns with spaces
    ac.update(extra)
    return ac


# (hex, callsign, bearing, distance km) -- notional traffic around the center
NOTIONAL = [
    fake_ac("aaa001", "DAL100", 0.0, 5.0),     # due north, close
    fake_ac("aaa002", "UAL200", 10.0, 11.0),   # north, in a heading=0 cone
    fake_ac("aaa003", "SWA300", 350.0, 8.0),   # just west of north, crosses 0/360 wrap
    fake_ac("aaa004", "AAL400", 16.0, 3.0),    # just outside a 30-degree cone at heading=0
    fake_ac("aaa005", "FFT500", 180.0, 10.0),  # due south (toward ATL)
    fake_ac("aaa006", "N12345", 185.0, 2.0, t="C172", alt_baro="ground"),
    fake_ac("aaa007", "JBU700", 90.0, 30.0),   # east, beyond the 15 km default radius
    fake_ac("aaa008", None, 270.0, 6.0, t=None),  # no callsign / type at all
    {"hex": "aaa009", "flight": "BAD999  "},    # no position -> must be dropped
    fake_ac("aaa001", "DAL100", 0.0, 5.0),     # duplicate hex -> must be deduped
]

ROUTES = {"DAL100": ("ATL", "JFK"), "UAL200": ("ORD", "ATL")}

failures = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global failures
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{'' if cond else '  -> ' + detail}")
    if not cond:
        failures += 1


def test_geo() -> None:
    print("geo")
    atl = (33.6407, -84.4277)
    b, d = bearing_deg(*CENTER, *atl), haversine_km(*CENTER, *atl)
    check("GT -> ATL bearing ~191", abs(b - 191) < 2, f"{b:.1f}")
    check("GT -> ATL distance ~15.3 km", abs(d - 15.3) < 0.5, f"{d:.2f}")
    check("bearing due east ~90", abs(bearing_deg(0, 0, 0, 1) - 90) < 1e-6)
    check("bearing in [0,360)", 0 <= bearing_deg(0, 0, 1, -0.0001) < 360)
    check("angle_diff wraps 5 vs 355 = +10", angle_diff(5, 355) == 10)
    check("angle_diff wraps 355 vs 5 = -10", angle_diff(355, 5) == -10)
    check("in_cone edge (15 of 30) inclusive", in_cone(15, 0, 30))
    check("in_cone just outside", not in_cone(15.1, 0, 30))
    check("in_cone across north", in_cone(359, 5, 30))


def test_route_parsing() -> None:
    print("route parsing")
    ap = lambda code, lat, lon: {"iata": code, "icao": "K" + code, "lat": lat, "lon": lon}  # noqa: E731
    atl, mia, jfk = ap("ATL", 33.64, -84.43), ap("MIA", 25.79, -80.29), ap("JFK", 40.64, -73.78)
    simple = {"plausible": True, "_airports": [atl, jfk]}
    check("simple route", adsb.parse_route(simple) == ("ATL", "JFK"))
    check("implausible route ignored", adsb.parse_route({**simple, "plausible": False}) == (None, None))
    tri = {"plausible": True, "_airports": [atl, mia, jfk]}
    check("multi-leg picks ATL->MIA near Orlando", adsb.parse_route(tri, 28.5, -81.3) == ("ATL", "MIA"))
    check("multi-leg picks MIA->JFK near Carolina coast", adsb.parse_route(tri, 34.0, -77.0) == ("MIA", "JFK"))
    round_trip = adsb.parse_route({"plausible": True, "_airports": [atl, mia, atl]}, 30.0, -82.0)
    check("round trip never returns same airport", round_trip[0] != round_trip[1], str(round_trip))


def test_endpoint() -> None:
    print("endpoint (adsb.lol stubbed with notional data)")

    async def fake_point(lat, lon, nm):
        return NOTIONAL

    async def fake_routes(planes):
        return {p["callsign"]: ROUTES[p["callsign"]] for p in planes if p["callsign"] in ROUTES}

    adsb.fetch_point, adsb.fetch_routes = fake_point, fake_routes
    client = TestClient(app)
    base = f"/api/flights/nearby?lat={CENTER[0]}&lon={CENTER[1]}"

    r = client.get(base)
    body = r.json()
    ids = [p["id"] for p in body["planes"]]
    check("200 OK", r.status_code == 200, str(r.status_code))
    check("response keys", set(body) == {"center", "demo", "fetchedAt", "planes"}, str(set(body)))
    check("Plane keys match contract", all(set(p) == PLANE_KEYS for p in body["planes"]))
    check("no position -> dropped", "aaa009" not in ids)
    check("duplicate hex deduped", ids.count("aaa001") == 1)
    check("beyond 15 km radius dropped", "aaa007" not in ids)
    check("7 planes total", len(ids) == 7, str(ids))
    dists = [p["distanceKm"] for p in body["planes"]]
    check("sorted by distance", dists == sorted(dists), str(dists))
    by_id = {p["id"]: p for p in body["planes"]}
    check("callsign trimmed", by_id["aaa001"]["callsign"] == "DAL100")
    check("airline from prefix", by_id["aaa001"]["airline"] == "Delta Air Lines")
    check("tail-number callsign -> no airline", by_id["aaa006"]["airline"] is None)
    check("typeName lookup", by_id["aaa006"]["typeName"] == "Cessna 172 Skyhawk")
    check("alt_baro 'ground' -> 0", by_id["aaa006"]["altitudeFt"] == 0)
    check("route applied", (by_id["aaa002"]["origin"], by_id["aaa002"]["destination"]) == ("ORD", "ATL"))
    check("no route -> nulls", by_id["aaa005"]["origin"] is None)
    check("nulls handled", by_id["aaa008"]["callsign"] is None and by_id["aaa008"]["typeName"] is None)
    check("bearing ~180 for south plane", abs(by_id["aaa005"]["bearingDeg"] - 180) < 0.1)
    check("distance ~10 km for south plane", abs(by_id["aaa005"]["distanceKm"] - 10) < 0.05)
    check("ground plane flagged onGround", by_id["aaa006"]["onGround"] is True and by_id["aaa001"]["onGround"] is False)

    ids0 = [p["id"] for p in client.get(base + "&heading=0").json()["planes"]]
    check("heading=0 cone: N planes incl. across wrap", ids0 == ["aaa001", "aaa003", "aaa002"], str(ids0))
    check("heading=0 cone excludes 16 deg plane", "aaa004" not in ids0)
    ids360 = [p["id"] for p in client.get(base + "&heading=360").json()["planes"]]
    check("heading=360 same as 0", ids360 == ids0, str(ids360))
    ids180 = [p["id"] for p in client.get(base + "&heading=180").json()["planes"]]
    check("heading=180 cone", ids180 == ["aaa006", "aaa005"], str(ids180))
    ids_wide = [p["id"] for p in client.get(base + "&heading=0&fovDeg=40").json()["planes"]]
    check("fovDeg=40 includes 16 deg plane", "aaa004" in ids_wide, str(ids_wide))
    ids_r = [p["id"] for p in client.get(base + "&radiusKm=40").json()["planes"]]
    check("radiusKm=40 includes 30 km plane", "aaa007" in ids_r)

    check("missing lat/lon -> 422", client.get("/api/flights/nearby").status_code == 422)
    check("bad lat -> 422", client.get("/api/flights/nearby?lat=200&lon=0").status_code == 422)

    demo = client.get("/api/flights/nearby?demo=1").json()
    check("demo mode flag + GT center", demo["demo"] is True and demo["center"] == {"lat": 33.7756, "lon": -84.3963})
    check("demo snapshot has planes", len(demo["planes"]) > 0, "run scripts/capture_snapshot.py")


def test_status_fields() -> None:
    print("status fields (kind / emergency / military / medical)")
    from app.normalize import normalize

    n = lambda **extra: normalize(fake_ac("bbb001", extra.pop("flight", "DAL1"), 0.0, 5.0, **extra), *CENTER)  # noqa: E731
    plain = n()
    check("plain airliner: no flags", (plain["kind"], plain["onGround"], plain["emergency"], plain["military"], plain["medical"]) == ("plane", False, None, False, False))
    check("category A7 -> helicopter", n(category="A7", t=None)["kind"] == "helicopter")
    check("R44 type w/o category -> helicopter", n(t="R44")["kind"] == "helicopter")
    check("emergency status passed through", n(emergency="general")["emergency"] == "general")
    check("emergency 'none' -> null", n(emergency="none")["emergency"] is None)
    check("squawk 7700 -> general", n(squawk="7700")["emergency"] == "general")
    check("squawk 7600 -> nordo", n(squawk="7600")["emergency"] == "nordo")
    life = n(emergency="lifeguard")
    check("lifeguard -> medical, not emergency", life["medical"] is True and life["emergency"] is None)
    check("air-ambulance callsign -> medical", n(flight="GRDIAN1")["medical"] is True)
    check("dbFlags bit 1 -> military", n(dbFlags=1)["military"] is True)
    check("dbFlags 8 (LADD) -> not military", n(dbFlags=8)["military"] is False)


def test_rate_limit() -> None:
    print("rate limiting / GPS jitter (adsb.lol mocked)")
    import importlib

    importlib.reload(adsb)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if len(calls) == 1:
            return httpx.Response(200, json={"ac": [{"hex": "x1"}]})
        return httpx.Response(429, headers={"retry-after": "30"})

    real = httpx.AsyncClient
    httpx.AsyncClient = lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    try:
        a = asyncio.run(adsb.fetch_point(33.77561, -84.39631, 9))
        check("first fetch ok", a == [{"hex": "x1"}])
        b = asyncio.run(adsb.fetch_point(33.7759, -84.3968, 9))  # GPS jitter, same ~1 km cell
        check("GPS jitter reuses the cache (no 2nd upstream call)", len(calls) == 1 and b == a, str(calls))
        time.sleep(1.1)  # cache expires
        c = asyncio.run(adsb.fetch_point(33.7756, -84.3963, 9))
        check("429 -> last good data, not an empty sky", len(calls) == 2 and c == a, str(len(calls)))
        d = asyncio.run(adsb.fetch_point(33.9, -84.1, 20))  # different position/radius during cooldown
        check("cooldown: no upstream call, last good served", len(calls) == 2 and d == a, str(len(calls)))
    finally:
        httpx.AsyncClient = real


def test_upstream_failure() -> None:
    print("upstream failure (real fetch_point, unreachable host)")
    import importlib

    importlib.reload(adsb)  # restore real functions
    adsb.POINT_URL = "https://nonexistent.invalid/{lat}/{lon}/{nm}"
    ac = asyncio.run(adsb.fetch_point(0.0, 0.0, 5))
    check("unreachable adsb.lol -> [] not exception", ac == [])


if __name__ == "__main__":
    test_geo()
    test_route_parsing()
    test_endpoint()
    test_status_fields()
    test_rate_limit()
    test_upstream_failure()
    print(f"\n{'ALL PASSED' if failures == 0 else f'{failures} FAILED'}")
    sys.exit(1 if failures else 0)
