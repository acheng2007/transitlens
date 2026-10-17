from contextlib import asynccontextmanager, suppress
import asyncio
from datetime import datetime, timezone
from pygeomag import GeoMag
from pygeomag.wmm.wmm_2025 import WMM_2025

import httpx
from fastapi import FastAPI, Query

from .geo import angle_diff, bearing_deg, haversine_km, in_cone
from .rts import RTS
from .network import Network, plan_direct


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient() as client:
        app.state.rts = RTS(client)
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
               lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180), demo: bool = False):
    catalog = await app.state.network.snapshot(demo)
    vehicles = [] if demo else (await app.state.rts.snapshot())[0]
    result = plan_direct(catalog, destination, lat, lon, vehicles)
    # Query a small number of stationary stops, reusing a short prediction cache.
    for option in result['options'][:3]:
        option['prediction'] = await app.state.network.arrivals(option['boardingStop']['id'], option['routeId'], option['direction'], demo)
    return result
