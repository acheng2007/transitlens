"""adsb.lol client: nearby aircraft + best-effort route lookup (both cached)."""
import logging
import time

import httpx

from .cache import TTLCache
from .geo import haversine_km

log = logging.getLogger(__name__)

POINT_URL = "https://api.adsb.lol/v2/point/{lat:.4f}/{lon:.4f}/{nm}"
# api.adsb.lol/api/0/routeset currently returns an empty 201; adsb.im serves the same data.
ROUTESET_URLS = ["https://adsb.im/api/0/routeset", "https://api.adsb.lol/api/0/routeset"]
MAX_RADIUS_NM = 250
TIMEOUT = httpx.Timeout(5.0)
# adsb.lol 403s the default python-httpx User-Agent.
HEADERS = {"User-Agent": "TransitLens/0.1 (hackathon)"}

_point_cache = TTLCache(ttl_s=1.0)  # matches the web app polling every 1 s
_route_cache = TTLCache(ttl_s=30 * 60)  # callsign -> (origin, destination), (None, None) if unknown

# Query center is snapped to a ~1 km grid (2 decimals) so GPS jitter doesn't create a new cache
# key (and a new upstream call) every poll. Callers recompute distance/bearing from the user's
# exact position and trim to the real radius; main.py already adds a 1 nm margin to cover the snap.
KEY_DECIMALS = 2
# adsb.lol rate-limits (429). Back off for Retry-After seconds (default below) instead of retrying.
RATE_LIMIT_BACKOFF_S = 5.0
_cooldown_until = 0.0
# Most recent successful response for any key: shown instead of an empty sky when upstream fails.
_last_good: list[dict] | None = None


def _retry_after_s(r: httpx.Response) -> float:
    try:
        return max(1.0, min(60.0, float(r.headers.get("retry-after", RATE_LIMIT_BACKOFF_S))))
    except ValueError:
        return RATE_LIMIT_BACKOFF_S


async def fetch_point(lat: float, lon: float, radius_nm: float) -> list[dict]:
    """Raw readsb aircraft within radius_nm. Falls back to the last good result on failure."""
    global _cooldown_until, _last_good
    nm = max(1, min(MAX_RADIUS_NM, round(radius_nm)))
    qlat, qlon = round(lat, KEY_DECIMALS), round(lon, KEY_DECIMALS)
    key = (qlat, qlon, nm)
    cached = _point_cache.get(key)
    if cached is not None:
        return cached
    fallback = _point_cache.get_stale(key) or _last_good or []
    if time.monotonic() < _cooldown_until:
        return fallback
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS) as client:
            r = await client.get(POINT_URL.format(lat=qlat, lon=qlon, nm=nm))
            if r.status_code == 429:
                wait = _retry_after_s(r)
                _cooldown_until = time.monotonic() + wait
                log.warning("adsb.lol rate limited (429); backing off %.0f s", wait)
                return fallback
            r.raise_for_status()
            ac = r.json().get("ac") or []
        _point_cache.set(key, ac)
        _last_good = ac
        return ac
    except Exception as e:  # never let upstream failures surface as 500s
        log.warning("adsb.lol point fetch failed: %s", e)
        return fallback


def parse_route(entry: dict, lat: float | None = None, lon: float | None = None) -> tuple[str | None, str | None]:
    if not entry.get("plausible"):
        return (None, None)
    airports = [a for a in entry.get("_airports") or [] if a.get("lat") is not None]
    codes = [a.get("iata") or a.get("icao") for a in airports]
    if len(airports) < 2 or not all(codes):
        return (None, None)
    if len(airports) == 2 or lat is None or lon is None:
        return (codes[0], codes[1])
    # Multi-leg (e.g. ATL-MIA-ATL): pick the leg with the smallest detour via the plane's position.
    def detour(i: int) -> float:
        a, b = airports[i], airports[i + 1]
        return (
            haversine_km(a["lat"], a["lon"], lat, lon)
            + haversine_km(lat, lon, b["lat"], b["lon"])
            - haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
        )
    i = min(range(len(airports) - 1), key=detour)
    return (codes[i], codes[i + 1])


async def fetch_routes(planes: list[dict]) -> dict[str, tuple[str | None, str | None]]:
    """Map callsign -> (origin, destination) for normalized planes. Best effort, never raises."""
    result: dict[str, tuple[str | None, str | None]] = {}
    missing = []
    for p in planes:
        cs = p.get("callsign")
        if not cs or cs in result:
            continue
        hit = _route_cache.get(cs)
        if hit is not None:
            result[cs] = hit
        else:
            missing.append({"callsign": cs, "lat": p["lat"], "lng": p["lon"]})
    if not missing:
        return result

    for url in ROUTESET_URLS:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS) as client:
                r = await client.post(url, json={"planes": missing})
                r.raise_for_status()
                data = r.json() if r.content else None
            if not isinstance(data, list):
                continue
            positions = {m["callsign"]: (m["lat"], m["lng"]) for m in missing}
            for entry in data:
                cs = (entry.get("callsign") or "").strip()
                if cs:
                    route = parse_route(entry, *positions.get(cs, (None, None)))
                    _route_cache.set(cs, route)
                    result[cs] = route
            break
        except Exception as e:
            log.warning("routeset lookup failed at %s: %s", url, e)
    return result
