"""Route patterns, stops, and deterministic direct-service queries from RTS BusTime.

Patterns come from `getpatterns?rt=`, which returns default and currently active
patterns only. Stops are derived from pattern stop points, so every stop carries
the routes, directions, and positions that actually serve it.
"""
import asyncio
import math
import os
import re
import time
from datetime import datetime, timezone

import httpx

from .geo import bearing_deg, haversine_km
from .rts import number, text

KM_PER_FOOT = 0.0003048
APPROXIMATE_NOTE = 'approximate direction, not a walking route'
DIRECT_LIMITATIONS = (
    'Direct routes only; transfers are not considered.',
    'Coverage comes from published route patterns, not live arrivals or confirmation that a bus is operating now.',
    'Distances and bearings are straight-line approximations, not walking routes.',
    'Only default and currently active RTS patterns are included.',
)
HEX_COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')
# Unknown patterns are fetched only when a live vehicle reports them.
ON_DEMAND_RETRY_SECONDS = 600
ON_DEMAND_DAILY_RESERVE = 300


def normalize_pattern(row, route_id):
    """Return a normalized pattern, or None when the upstream row is unusable."""
    if not isinstance(row, dict) or not isinstance(row.get('pt'), list):
        return None
    pattern_id = text(row.get('pid'))
    if not pattern_id:
        return None
    points, stops = [], []
    rows = [p for p in row['pt'] if isinstance(p, dict) and number(p.get('seq')) is not None]
    for point in sorted(rows, key=lambda p: number(p.get('seq'))):
        lat, lon = number(point.get('lat')), number(point.get('lon'))
        if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180 or (lat == 0 and lon == 0):
            continue
        points.append([lat, lon])
        stop_id = text(point.get('stpid'))
        if point.get('typ') == 'S' and stop_id:
            pdist = number(point.get('pdist'))
            stops.append(dict(id=stop_id, name=text(point.get('stpnm')) or stop_id, lat=lat, lon=lon,
                              sequence=len(stops),
                              distanceKm=pdist * KM_PER_FOOT if pdist is not None and pdist >= 0 else None))
    if len(points) < 2:
        return None
    length = number(row.get('ln'))
    return dict(id=pattern_id, routeId=route_id, direction=text(row.get('rtdir')),
                lengthKm=length * KM_PER_FOOT if length is not None and length >= 0 else None,
                detour=bool(text(row.get('dtrid'))), points=points, stops=stops)


def normalize_route(row):
    route_id = text(row.get('rt')) if isinstance(row, dict) else None
    if not route_id:
        return None
    color = text(row.get('rtclr'))
    return dict(id=route_id, display=text(row.get('rtdd')) or route_id, name=text(row.get('rtnm')),
                color=color if color and HEX_COLOR.match(color) else None)


def build_stops(patterns, routes):
    stops = {}
    for pattern in patterns.values():
        route = routes.get(pattern['routeId'], {})
        for stop in pattern['stops']:
            entry = stops.setdefault(stop['id'], dict(id=stop['id'], name=stop['name'], lat=stop['lat'],
                                                      lon=stop['lon'], routes=[]))
            service = dict(routeId=pattern['routeId'], routeDisplay=route.get('display', pattern['routeId']),
                           direction=pattern['direction'], patternId=pattern['id'])
            if service not in entry['routes']:
                entry['routes'].append(service)
    for entry in stops.values():
        entry['routes'].sort(key=lambda s: (s['routeDisplay'], s['direction'] or '', s['patternId']))
    return stops


def search_tokens(value):
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).split()


class TransitCatalog:
    def __init__(self, rts, ttl=None):
        self.rts = rts
        self.ttl = max(60, float(ttl if ttl is not None else os.getenv('RTS_CATALOG_TTL_SECONDS', '86400')))
        self.routes = {}
        self.patterns = {}
        self.stops = {}
        self.fetched_at = None
        self.failed = False
        self.loaded_at = float('-inf')
        self.attempt_at = float('-inf')
        self.on_demand_attempts = {}
        self.lock = asyncio.Lock()

    def daily_calls(self, route_count=None):
        """Upstream calls per day reserved for the catalog and on-demand pattern lookups."""
        count = route_count if route_count is not None else max(len(self.routes), 30)
        return math.ceil(86400 / self.ttl) * (count + 1) + ON_DEMAND_DAILY_RESERVE

    def status(self):
        return 'stale' if self.failed and self.fetched_at else 'unavailable' if self.failed or not self.fetched_at else 'available'

    def envelope(self, **body):
        return dict(status=self.status(), fetchedAt=self.fetched_at, **body)

    async def ensure(self):
        async with self.lock:
            now = time.monotonic()
            due = now - self.loaded_at >= self.ttl
            # A failed refresh waits before retrying so a missing key or outage cannot spend the budget.
            if not due or now - self.attempt_at < min(self.ttl, 300):
                return
            try:
                routes = {}
                for row in await self.rts.request('getroutes', 'route'):
                    route = normalize_route(row)
                    if route:
                        routes[route['id']] = route
                if not routes:
                    raise ValueError('Empty route catalog')
                patterns = {}
                for route_id in routes:
                    for row in await self.rts.request('getpatterns', 'ptr', rt=route_id):
                        pattern = normalize_pattern(row, route_id)
                        if pattern:
                            patterns[pattern['id']] = pattern
                if not patterns:
                    raise ValueError('Empty pattern catalog')
                self.routes, self.patterns = routes, patterns
                self.stops = build_stops(patterns, routes)
                self.fetched_at = datetime.now(timezone.utc).isoformat()
                self.loaded_at = time.monotonic()
                self.failed = False
                self.on_demand_attempts.clear()
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                self.failed = True
            finally:
                self.attempt_at = time.monotonic()

    async def pattern(self, pattern_id, active_ids):
        """Return a cached pattern, fetching it once if a live vehicle currently reports it."""
        await self.ensure()
        if pattern_id in self.patterns or pattern_id not in active_ids:
            return self.patterns.get(pattern_id)
        async with self.lock:
            now = time.monotonic()
            if pattern_id in self.patterns or now - self.on_demand_attempts.get(pattern_id, float('-inf')) < ON_DEMAND_RETRY_SECONDS:
                return self.patterns.get(pattern_id)
            self.on_demand_attempts[pattern_id] = now
            route_id = active_ids[pattern_id]
            try:
                for row in await self.rts.request('getpatterns', 'ptr', pid=pattern_id):
                    pattern = normalize_pattern(row, route_id)
                    if pattern and pattern['id'] == pattern_id:
                        self.patterns[pattern_id] = pattern
                        self.stops = build_stops(self.patterns, self.routes)
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                pass
            return self.patterns.get(pattern_id)

    def route_summary(self, route):
        directions = sorted({p['direction'] for p in self.patterns.values() if p['routeId'] == route['id'] and p['direction']})
        return {**route, 'directions': directions}

    def pattern_body(self, pattern):
        route = self.routes.get(pattern['routeId'], {})
        return {**pattern, 'routeDisplay': route.get('display', pattern['routeId']), 'routeName': route.get('name'),
                'routeColor': route.get('color')}

    def route_detail(self, route_id):
        route = self.routes.get(route_id)
        if not route:
            return None
        patterns = sorted((p for p in self.patterns.values() if p['routeId'] == route_id),
                          key=lambda p: (p['detour'], p['direction'] or '', p['id']))
        return {**self.route_summary(route), 'patterns': [self.pattern_body(p) for p in patterns]}

    def nearby_stops(self, lat, lon, radius_km, limit):
        results = []
        for stop in self.stops.values():
            distance = haversine_km(lat, lon, stop['lat'], stop['lon'])
            if distance <= radius_km:
                results.append({**stop, 'distanceKm': distance, 'bearingDeg': bearing_deg(lat, lon, stop['lat'], stop['lon'])})
        results.sort(key=lambda s: (s['distanceKm'], s['id']))
        return results[:limit]

    def search_stops(self, query, limit):
        tokens = search_tokens(query)
        phrase = ' '.join(tokens)
        matches = []
        for stop in self.stops.values():
            name = ' '.join(search_tokens(stop['name']))
            if tokens and all(token in name for token in tokens):
                rank = 0 if name == phrase else 1 if name.startswith(phrase) else 2
                matches.append((rank, len(name), stop['name'], stop['id'], stop))
        matches.sort(key=lambda m: m[:4])
        return [m[4] for m in matches[:limit]]

    def direct_options(self, origin, destination, active_counts, limit):
        """Rank routes whose pattern reaches a destination stop after an origin stop.

        `origin` and `destination` map stop ID to straight-line distance from the
        requested point, or to None when the caller named that stop explicitly.
        """
        best = {}
        for pattern in self.patterns.values():
            boardings = [s for s in pattern['stops'] if s['id'] in origin]
            alightings = [s for s in pattern['stops'] if s['id'] in destination]
            for board in boardings:
                for alight in alightings:
                    if alight['sequence'] <= board['sequence'] or alight['id'] == board['id']:
                        continue
                    walk = (origin[board['id']] or 0) + (destination[alight['id']] or 0)
                    ride = (alight['distanceKm'] - board['distanceKm']
                            if alight['distanceKm'] is not None and board['distanceKm'] is not None else None)
                    score = (walk, ride if ride is not None else math.inf, alight['sequence'] - board['sequence'])
                    key = (pattern['routeId'], pattern['direction'])
                    if key not in best or score < best[key][0]:
                        best[key] = (score, pattern, board, alight, ride)
        options = []
        for score, pattern, board, alight, ride in sorted(best.values(), key=lambda b: (b[0], b[1]['routeId'])):
            route = self.routes.get(pattern['routeId'], {})
            options.append(dict(
                routeId=pattern['routeId'], routeDisplay=route.get('display', pattern['routeId']),
                routeName=route.get('name'), routeColor=route.get('color'), direction=pattern['direction'],
                patternId=pattern['id'], detour=pattern['detour'],
                boardStop=self.stop_ref(board), alightStop=self.stop_ref(alight),
                stopsBetween=alight['sequence'] - board['sequence'], rideKm=ride,
                activeVehicleCount=active_counts.get((pattern['routeId'], pattern['direction']), 0)))
        return options[:limit]

    def stop_ref(self, stop):
        return dict(id=stop['id'], name=stop['name'], lat=stop['lat'], lon=stop['lon'])
