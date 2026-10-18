"""Deterministic vehicle/stop queries. Distances never imply arrival times."""
import math

from .geo import haversine_km, bearing_deg, angle_diff
from .network import find_destination


def progress_on_pattern(vehicle, pattern):
    """Conservative projection: reject distant roads, reversed headings and ambiguous loops."""
    points = pattern['shape']
    cumulative = [0.0]
    candidates = []
    for a, b in zip(points, points[1:]):
        length = haversine_km(a['lat'], a['lon'], b['lat'], b['lon'])
        cumulative.append(cumulative[-1] + length)
        if length < 0.001:
            continue
        scale = math.cos(math.radians(vehicle['lat']))
        dx, dy = (b['lon'] - a['lon']) * scale, b['lat'] - a['lat']
        vx, vy = (vehicle['lon'] - a['lon']) * scale, vehicle['lat'] - a['lat']
        t = min(1, max(0, (vx * dx + vy * dy) / (dx * dx + dy * dy)))
        lat, lon = a['lat'] + t * (b['lat'] - a['lat']), a['lon'] + t * (b['lon'] - a['lon'])
        offset = haversine_km(vehicle['lat'], vehicle['lon'], lat, lon)
        heading = vehicle.get('headingDeg')
        if heading is not None and (vehicle.get('speedMph') or 0) > 2:
            if abs(angle_diff(heading, bearing_deg(a['lat'], a['lon'], b['lat'], b['lon']))) > 90:
                continue
        candidates.append((offset, cumulative[-2] + t * length))
    if not candidates:
        return None, cumulative
    candidates.sort()
    offset, progress = candidates[0]
    if offset > 0.075 or any(d <= offset + 0.025 and abs(p - progress) > 0.2 for d, p in candidates[1:]):
        return None, cumulative
    return progress, cumulative


def vehicle_at_stop(vehicle, stop, patterns):
    distance = haversine_km(vehicle['lat'], vehicle['lon'], stop['lat'], stop['lon'])
    result = dict(busId=vehicle['id'], routeId=vehicle['route'], patternId=vehicle.get('patternId'),
                  destination=vehicle.get('destination'), lat=vehicle['lat'], lon=vehicle['lon'],
                  distanceKm=round(distance, 4), alongRouteKm=None, progress='unknown', prediction=None)
    pattern = next((p for p in patterns if p['routeId'] == vehicle['route'] and p['patternId'] == vehicle.get('patternId')), None)
    if not pattern:
        return result
    matches = [s for s in pattern['stops'] if s['id'] == stop['id']]
    if not matches:
        result['progress'] = 'not_served'
        return result
    position, cumulative = progress_on_pattern(vehicle, pattern)
    # Repeated stops on a loop require an occurrence choice, never an implicit next lap.
    if position is None or len(matches) != 1:
        return result
    remaining = cumulative[matches[0]['sequence']] - position
    result.update(progress='passed' if remaining < -0.03 else 'approaching',
                  alongRouteKm=round(max(0, remaining), 4) if remaining >= -0.03 else None)
    return result


def stop_query(network, vehicles, query, route_id=None, bus_id=None):
    stops = find_destination(network['patterns'], query)
    base = dict(query=query, routeId=route_id, busId=bus_id, demo=network['demo'],
                networkStatus=network['status'], fetchedAt=network['fetchedAt'],
                vehicleStatus='unavailable', vehicleFetchedAt=None,
                status='available', stops=stops[:8], stop=None, vehicles=[], routes=[])
    if network['status'] == 'unavailable':
        return {**base, 'status': 'unavailable'}
    if not stops:
        return {**base, 'status': 'not_found'}
    if len(stops) > 1:
        return {**base, 'status': 'ambiguous'}
    stop = stops[0]
    matched = [v for v in vehicles if (not route_id or v['route'] == route_id) and (not bus_id or v['id'] == bus_id)]
    rows = [vehicle_at_stop(v, stop, network['patterns']) for v in matched]
    if network['status'] != 'available':
        for row in rows:
            row.update(progress='unknown', alongRouteKm=None)
    rows.sort(key=lambda v: (v['progress'] in ('passed', 'not_served'), v['distanceKm'], v['busId']))
    routes = [p for p in network['patterns'] if (not route_id or p['routeId'] == route_id)
              and any(v['patternId'] == p['patternId'] and v['routeId'] == p['routeId'] for v in rows[:6])][:6]
    return {**base, 'stop': stop, 'vehicles': rows[:6], 'routes': routes}


def route_details(network, vehicles, route_id=None, bus_id=None):
    bus = next((v for v in vehicles if v['id'] == bus_id), None)
    route_id = bus['route'] if bus else route_id
    if bus_id and not bus:
        route_id = None
    patterns = [p for p in network['patterns'] if p['routeId'] == route_id
                and (not bus or not bus.get('patternId') or p['patternId'] == bus['patternId'])]
    next_stops = []
    if bus and len(patterns) == 1:
        position, cumulative = progress_on_pattern(bus, patterns[0])
        if position is not None:
            next_stops = [s for s in patterns[0]['stops'] if cumulative[s['sequence']] > position + 0.03][:5]
    return dict(status='unavailable' if network['status'] == 'unavailable' else 'available' if patterns else 'not_found',
                networkStatus=network['status'], demo=network['demo'], routeId=route_id,
                routes=patterns[:6], buses=[v for v in vehicles if v['route'] == route_id and (not bus_id or v['id'] == bus_id)][:6], nextStops=next_stops)
