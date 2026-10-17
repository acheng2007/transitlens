"""Authoritative route patterns, direct trips and boarding-stop context."""
import asyncio
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from .geo import haversine_km
from .rts import number, text

FIXTURE = Path(__file__).resolve().parents[2] / 'shared/fixtures/gainesville-network.json'


def normalize_pattern(route, pattern):
    points, stops = [], []
    for p in sorted(pattern.get('pt', []), key=lambda p: number(p.get('seq')) or 0):
        lat, lon = number(p.get('lat')), number(p.get('lon'))
        if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180:
            continue
        position = dict(lat=lat, lon=lon)
        points.append(position)
        if p.get('typ') == 'S' and text(p.get('stpid')) and text(p.get('stpnm')):
            stops.append(dict(id=str(p['stpid']), name=p['stpnm'], sequence=len(points) - 1, **position))
    if len(points) < 2 or not stops or not text(pattern.get('pid')) or not text(pattern.get('rtdir')):
        return None
    return dict(id=f"{route['rt']}:{pattern['pid']}", patternId=str(pattern['pid']),
                routeId=route['rt'], name=route.get('rtnm') or f"Route {route['rt']}",
                color=route.get('rtclr') if re.fullmatch(r'#[0-9a-fA-F]{6}', route.get('rtclr', '')) else '#5ce1e6',
                direction=pattern['rtdir'], shape=points, stops=stops)


class Network:
    def __init__(self, rts):
        self.rts = rts
        self.cached = None
        self.attempt_at = float('-inf')
        self.lock = asyncio.Lock()
        self.predictions = {}

    async def snapshot(self, demo=False):
        if demo:
            data = json.loads(FIXTURE.read_text())
            return {**data, 'demo': True, 'status': 'available'}
        async with self.lock:
            ttl = 3600 if self.cached and self.cached['status'] in ('available', 'partial') else 60
            if time.monotonic() - self.attempt_at < ttl:
                return self.cached or dict(status='unavailable', demo=False, patterns=[], fetchedAt=None)
            self.attempt_at = time.monotonic()
            try:
                routes = await self.rts.request('getroutes', 'route')
                if not routes:
                    raise ValueError('Empty route catalog')
                limit = asyncio.Semaphore(3)
                async def get(route):
                    async with limit:
                        try:
                            rows = await self.rts.request('getpatterns', 'ptr', rt=route['rt'])
                            return [p for row in rows if (p := normalize_pattern(route, row))], True
                        except Exception:
                            return [], False
                rows = await asyncio.gather(*(get(r) for r in routes))
                patterns = [p for batch, _ in rows for p in batch]
                if not patterns:
                    raise ValueError('No patterns')
                self.cached = dict(demo=False, status='available' if all(ok for _, ok in rows) else 'partial',
                                   patterns=patterns, fetchedAt=datetime.now(timezone.utc).isoformat())
            except Exception:
                self.cached = {**(self.cached or dict(patterns=[], fetchedAt=None)), 'demo': False,
                               'status': 'stale' if self.cached else 'unavailable'}
            return self.cached

    async def arrivals(self, stop_id, route, direction, demo=False):
        if demo:
            return dict(status='demo', minutes=4, fetchedAt=None, vehicleId=None, label='Scripted arrival, not live')
        key = (stop_id, route, direction)
        cached = self.predictions.get(key)
        if cached and time.monotonic() - cached[0] < 30:
            return cached[1]
        try:
            rows = await self.rts.request('getpredictions', 'prd', stpid=stop_id, rt=route, top=10)
            candidates = []
            for row in rows:
                minutes = 0 if row.get('prdctdn') == 'DUE' else number(row.get('prdctdn'))
                if str(row.get('rt')) == route and row.get('rtdir') == direction and str(row.get('stpid')) == stop_id and minutes is not None and minutes >= 0:
                    candidates.append((minutes, str(row.get('vid', ''))))
            minutes, vehicle = min(candidates) if candidates else (None, None)
            result = dict(status='available', minutes=minutes, vehicleId=vehicle,
                          fetchedAt=datetime.now(timezone.utc).isoformat(), label='RTS prediction' if minutes is not None else 'No matching arrival prediction')
        except Exception:
            result = dict(status='unavailable', minutes=None, vehicleId=None, fetchedAt=None, label='Arrivals unavailable')
        self.predictions[key] = (time.monotonic(), result)
        return result


def clean(value):
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).strip()


def find_destination(patterns, query):
    """Resolve a named destination to actual stop names, never model coordinates."""
    stops = {s['id']: s for p in patterns for s in p['stops']}
    exact = stops.get(query)
    if exact:
        return [exact]
    q = clean(query)
    # Aliases expand to actual stop-name searches; they do not assert coverage.
    if q in ('shands', 'shands hospital', 'uf health shands'):
        terms = ['shands']
    elif q == 'uf health':
        terms = ['uf health']
    elif q in ('reitz', 'reitz union', 'the reitz', 'reitz student union'):
        terms = ['reitz']
    elif q in ('the hub', 'hub'):
        terms = ['hub']
    else:
        terms = [q]
    return [s for s in stops.values() if any(term and term in clean(s['name']) for term in terms)]


def plan_direct(network, query, lat, lon, vehicles=(), max_walk_km=0.8):
    patterns = network['patterns']
    destinations = find_destination(patterns, query)
    base = dict(query=query, demo=network['demo'], networkStatus=network['status'],
                fetchedAt=network['fetchedAt'], scope='Direct routes with a boarding stop within 0.8 km; current route patterns, not a schedule guarantee.',
                options=[], destinations=destinations[:8])
    if not destinations:
        return {**base, 'status': 'not_found' if network['status'] != 'unavailable' else 'unavailable'}
    # Geographically separate name matches require an explicit stop choice.
    if any(haversine_km(destinations[0]['lat'], destinations[0]['lon'], s['lat'], s['lon']) > 0.7 for s in destinations[1:]):
        return {**base, 'status': 'ambiguous'}
    ids = {s['id'] for s in destinations}
    options = []
    for pattern in patterns:
        for target in [s for s in pattern['stops'] if s['id'] in ids]:
            earlier = [s for s in pattern['stops'] if s['sequence'] < target['sequence'] and s['id'] != target['id']]
            nearby = [(haversine_km(lat, lon, s['lat'], s['lon']), s) for s in earlier]
            nearby = [(distance, s) for distance, s in nearby if distance <= max_walk_km]
            if not nearby:
                continue
            distance, boarding = min(nearby, key=lambda item: item[0])
            options.append(dict(id=f"{pattern['id']}:{boarding['id']}:{target['id']}:{target['sequence']}",
                routeId=pattern['routeId'], routeName=pattern['name'], color=pattern['color'],
                patternId=pattern['patternId'], direction=pattern['direction'], boardingStop=boarding,
                alightingStop=target, walkKm=round(distance, 3),
                rideStops=len([s for s in pattern['stops'] if boarding['sequence'] < s['sequence'] <= target['sequence']]),
                overlay=pattern, activeVehicles=sum(v['route'] == pattern['routeId'] for v in vehicles),
                prediction=None))
    # Retain direction/pattern distinctions; remove alternatives for the same boarding/route/direction.
    options.sort(key=lambda o: (o['walkKm'], o['rideStops']))
    unique = {}
    for option in options:
        unique.setdefault((option['routeId'], option['direction'], option['boardingStop']['id']), option)
    return {**base, 'status': 'available' if unique else 'no_direct_routes', 'options': list(unique.values())[:6]}
