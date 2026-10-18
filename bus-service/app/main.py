from contextlib import asynccontextmanager, suppress
import asyncio
from datetime import datetime, timezone
from pygeomag import GeoMag
from pygeomag.wmm.wmm_2025 import WMM_2025

import httpx
from fastapi import FastAPI, HTTPException, Path, Query

from .geo import angle_diff, bearing_deg, haversine_km, in_cone
from .rts import RTS
from .network import Network, plan_direct
from .queries import stop_query, route_details, vehicle_at_stop
from .transit import APPROXIMATE_NOTE, DIRECT_LIMITATIONS, TransitCatalog

ID_PATTERN = r'^[A-Za-z0-9_.-]+$'


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient() as client:
        app.state.rts = RTS(client)
        app.state.transit = TransitCatalog(app.state.rts)
        app.state.rts.reserved_daily_calls = app.state.transit.daily_calls()
        app.state.network = Network(app.state.rts)
        warmup = asyncio.create_task(app.state.network.snapshot()) if app.state.rts.key else None
        try:
            yield
        finally:
            if warmup:
                warmup.cancel()
                with suppress(asyncio.CancelledError):
                    await warmup


geomag = GeoMag(coefficients_data=WMM_2025)

app = FastAPI(title='TransitLens bus service', lifespan=lifespan)


@app.get('/api/buses/health')
async def health():
    return {'ok': True, 'hasKey': bool(app.state.rts.key)}


@app.get('/api/buses/nearby')
async def nearby(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180),
                 radiusKm: float = Query(5, gt=0, le=400), heading: float | None = Query(None, ge=0, lt=360),
                 fovDeg: float = Query(360, gt=0, le=360), demo: bool = False):
    if demo:
        from .demo import buses as demo_buses
        rows, fetched_at, status = demo_buses(), datetime.now(timezone.utc).isoformat(), 'available'
    else:
        rows, fetched_at, status = await app.state.rts.snapshot()
    buses = []
    for row in rows:
        distance = haversine_km(lat, lon, row['lat'], row['lon'])
        bearing = bearing_deg(lat, lon, row['lat'], row['lon'])
        if distance <= radiusKm and (heading is None or in_cone(bearing, heading, fovDeg)):
            buses.append({**row, 'distanceKm': distance, 'bearingDeg': bearing,
                          **({'offsetDeg': angle_diff(bearing, heading)} if heading is not None else {})})
    now = datetime.now(timezone.utc)
    start = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    end = datetime(now.year + 1, 1, 1, tzinfo=timezone.utc)
    year = now.year + (now - start).total_seconds() / (end - start).total_seconds()
    try:
        declination = geomag.calculate(glat=lat, glon=lon, alt=0, time=year).d
    except ValueError:
        declination = None
    return dict(magneticDeclinationDeg=declination, center=dict(lat=lat, lon=lon), demo=demo, fetchedAt=fetched_at,
                status=status, buses=sorted(buses, key=lambda b: b['distanceKm']))


@app.get('/api/buses/network')
async def network(demo: bool = False):
    return await app.state.network.snapshot(demo)


@app.get('/api/buses/plan')
async def plan(destination: str = Query(min_length=1, max_length=120),
               lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180), demo: bool = False,
               onboardBusId: str | None = Query(None, max_length=100)):
    catalog = await app.state.network.snapshot(demo)
    if demo:
        from .demo import buses
        vehicles, fetched, status = buses(), datetime.now(timezone.utc).isoformat(), 'available'
    else:
        vehicles, fetched, status = await app.state.rts.snapshot()
    onboard = next((v for v in vehicles if v['id'] == onboardBusId), None) if onboardBusId else None
    if onboardBusId and (not onboard or status != 'available' or catalog['status'] != 'available'):
        raise HTTPException(409, 'The selected onboard bus is no longer available in fresh vehicle data.')
    result = plan_direct(catalog, destination, lat, lon, vehicles, onboard=onboard)
    # Query a small number of stationary stops, reusing a short prediction cache.
    for option in result['options'][:3]:
        if option.get('onboard'):
            continue
        option['prediction'] = await app.state.network.arrivals(option['boardingStop']['id'], option['routeId'], option['direction'], demo)
        prediction = option['prediction']
        if not demo and prediction['minutes'] is not None and not any(
                v['id'] == prediction.get('vehicleId') and v['route'] == option['routeId'] and v.get('patternId') == option['patternId'] for v in vehicles):
            option['prediction'] = dict(status='unavailable', minutes=None, vehicleId=None, fetchedAt=prediction.get('fetchedAt'),
                                        label='The predicted vehicle could not be matched to this trip pattern')
    for option in result['options']:
        option['vehicles'] = [vehicle_at_stop(v, option['boardingStop'], catalog['patterns']) for v in vehicles
                              if v['route'] == option['routeId'] and v.get('patternId') == option['patternId']][:6] if status == 'available' else []
        option['vehicleStatus'] = status
        option['vehicleFetchedAt'] = fetched
    # Recommend a nearby boarding stop only with current evidence of upcoming service.
    viable = [o for o in result['options'] if o.get('onboard') or
              (o.get('prediction') and o['prediction']['minutes'] is not None) or
              any(v['progress'] == 'approaching' for v in o['vehicles'])]
    result['recommendedJourneyId'] = viable[0]['id'] if viable and status == 'available' and catalog['status'] == 'available' else None
    return result


@app.get('/api/buses/stop-distance')
async def bus_stop_distance(stop: str = Query(min_length=1, max_length=120),
                            routeId: str | None = Query(None, max_length=30, pattern=ID_PATTERN),
                            busId: str | None = Query(None, max_length=100, pattern=ID_PATTERN), demo: bool = False):
    network = await app.state.network.snapshot(demo)
    if demo:
        from .demo import buses
        vehicles, fetched, status = buses(), datetime.now(timezone.utc).isoformat(), 'available'
    else:
        vehicles, fetched, status = await app.state.rts.snapshot()
    result = stop_query(network, vehicles, stop, routeId, busId)
    result.update(vehicleStatus=status, vehicleFetchedAt=fetched)
    if result['stop'] and status == 'available':
        for vehicle in result['vehicles'][:3]:
            pattern = next((p for p in result['routes'] if p['patternId'] == vehicle['patternId'] and p['routeId'] == vehicle['routeId']), None)
            if pattern and vehicle['progress'] not in ('passed', 'not_served'):
                vehicle['prediction'] = await app.state.network.arrivals(result['stop']['id'], vehicle['routeId'], pattern['direction'], demo, vehicle['busId'])
    return result


@app.get('/api/buses/route-details')
async def bus_route_details(routeId: str | None = Query(None, max_length=30, pattern=ID_PATTERN),
                            busId: str | None = Query(None, max_length=100, pattern=ID_PATTERN), demo: bool = False):
    network = await app.state.network.snapshot(demo)
    if demo:
        from .demo import buses
        vehicles = buses()
        status = 'available'
    else:
        vehicles, _, status = await app.state.rts.snapshot()
    result = route_details(network, vehicles, routeId, busId)
    result['vehicleStatus'] = status
    if status != 'available' or network['status'] != 'available':
        result['nextStops'] = []
    return result
async def catalog(required=False):
    """Load the catalog. Lookups by ID require data, so absence is not reported as an unknown ID."""
    transit = app.state.transit
    await transit.ensure()
    if required and transit.status() == 'unavailable':
        raise HTTPException(503, 'Transit catalog temporarily unavailable')
    return transit


def require_point(lat, lon, name):
    if (lat is None) != (lon is None):
        raise HTTPException(422, f'{name}Lat and {name}Lon must be provided together')


@app.get('/api/transit/routes')
async def transit_routes():
    transit = await catalog()
    routes = sorted(transit.routes.values(), key=lambda r: (r['display'], r['id']))
    return transit.envelope(routes=[transit.route_summary(r) for r in routes])


@app.get('/api/transit/routes/{routeId}')
async def transit_route(routeId: str = Path(min_length=1, max_length=32, pattern=ID_PATTERN)):
    transit = await catalog(required=True)
    route = transit.route_detail(routeId)
    if route is None:
        raise HTTPException(404, 'Unknown route')
    return transit.envelope(route=route)


@app.get('/api/transit/patterns/{patternId}')
async def transit_pattern(patternId: str = Path(min_length=1, max_length=32, pattern=ID_PATTERN)):
    transit = await catalog(required=True)
    rows, _, _ = await app.state.rts.snapshot()
    active = {b['patternId']: b['route'] for b in rows if b.get('patternId')}
    pattern = await transit.pattern(patternId, active)
    if pattern is None:
        raise HTTPException(404, 'Unknown pattern')
    return transit.envelope(pattern=transit.pattern_body(pattern))


@app.get('/api/transit/stops/nearby')
async def transit_nearby_stops(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180),
                               radiusKm: float = Query(0.8, gt=0, le=5), limit: int = Query(20, ge=1, le=50), demo: bool = False):
    if demo:
        network = await app.state.network.snapshot(True)
        stops = {s['id']: s for p in network['patterns'] for s in p['stops']}
        nearby = [{**s, 'distanceKm': haversine_km(lat, lon, s['lat'], s['lon']),
                   'bearingDeg': bearing_deg(lat, lon, s['lat'], s['lon'])} for s in stops.values()]
        nearby = sorted((s for s in nearby if s['distanceKm'] <= radiusKm), key=lambda s: (s['distanceKm'], s['id']))[:limit]
        return dict(status='available', fetchedAt=network.get('fetchedAt'), demo=True,
                    center=dict(lat=lat, lon=lon), stops=nearby)
    transit = await catalog()
    return transit.envelope(center=dict(lat=lat, lon=lon), stops=transit.nearby_stops(lat, lon, radiusKm, limit))


@app.get('/api/transit/stops/search')
async def transit_search_stops(q: str = Query(min_length=2, max_length=100), limit: int = Query(10, ge=1, le=25)):
    transit = await catalog()
    return transit.envelope(query=q, stops=transit.search_stops(q, limit))


@app.get('/api/transit/direct')
async def transit_direct(fromStopId: str | None = Query(None, max_length=32, pattern=ID_PATTERN),
                         fromLat: float | None = Query(None, ge=-90, le=90),
                         fromLon: float | None = Query(None, ge=-180, le=180),
                         toStopId: str | None = Query(None, max_length=32, pattern=ID_PATTERN),
                         toLat: float | None = Query(None, ge=-90, le=90),
                         toLon: float | None = Query(None, ge=-180, le=180),
                         radiusKm: float = Query(0.8, gt=0, le=2), limit: int = Query(5, ge=1, le=10)):
    require_point(fromLat, fromLon, 'from')
    require_point(toLat, toLon, 'to')
    if (fromStopId is None) == (fromLat is None):
        raise HTTPException(422, 'Provide exactly one of fromStopId or fromLat/fromLon')
    if (toStopId is None) == (toLat is None):
        raise HTTPException(422, 'Provide exactly one of toStopId or toLat/toLon')
    transit = await catalog(required=True)

    def candidates(stop_id, lat, lon, name):
        if stop_id is not None:
            stop = transit.stops.get(stop_id)
            if stop is None:
                raise HTTPException(404, f'Unknown {name} stop')
            return {stop_id: None}, dict(stopId=stop_id, name=stop['name'], lat=stop['lat'], lon=stop['lon'])
        stops = transit.nearby_stops(lat, lon, radiusKm, 50)
        return {s['id']: s['distanceKm'] for s in stops}, dict(stopId=None, name=None, lat=lat, lon=lon)

    origin, origin_ref = candidates(fromStopId, fromLat, fromLon, 'origin')
    destination, destination_ref = candidates(toStopId, toLat, toLon, 'destination')
    rows, _, _ = await app.state.rts.snapshot()
    counts = {}
    for bus in rows:
        pattern = transit.patterns.get(bus.get('patternId') or '')
        if pattern:
            key = (pattern['routeId'], pattern['direction'])
            counts[key] = counts.get(key, 0) + 1
    options = transit.direct_options(origin, destination, counts, limit)
    for option in options:
        board, alight = option['boardStop'], option['alightStop']
        option['approachToBoarding'] = None if fromLat is None else dict(
            distanceKm=haversine_km(fromLat, fromLon, board['lat'], board['lon']),
            bearingDeg=bearing_deg(fromLat, fromLon, board['lat'], board['lon']), note=APPROXIMATE_NOTE)
        option['alightingToDestination'] = None if toLat is None else dict(
            distanceKm=haversine_km(alight['lat'], alight['lon'], toLat, toLon),
            bearingDeg=bearing_deg(alight['lat'], alight['lon'], toLat, toLon), note=APPROXIMATE_NOTE)
    return transit.envelope(coverage='direct-service', limitations=list(DIRECT_LIMITATIONS), searchRadiusKm=radiusKm,
                            origin=origin_ref, destination=destination_ref, options=options)
