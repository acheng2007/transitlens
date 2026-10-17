"""Server-only BusTime client. Never log exceptions containing credential URLs."""
import asyncio
import math
import logging
import os
import time
from datetime import datetime, timezone

import httpx

# httpx INFO logging includes full credential-bearing upstream URLs.
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None


def text(value):
    return str(value).strip() if value is not None and str(value).strip() else None


def normalize(rows):
    buses = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        lat, lon = number(row.get('lat')), number(row.get('lon'))
        vid, route = text(row.get('vid')), text(row.get('rt'))
        if not vid or not route or lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180 or (lat == 0 and lon == 0):
            continue
        heading, speed = number(row.get('hdg')), number(row.get('spd'))
        delay = row.get('dly')
        delay = delay if isinstance(delay, bool) else {'true': True, 'false': False}.get(str(delay).lower())
        load = text(row.get('psgld'))
        buses[vid] = dict(id=vid, route=route, destination=text(row.get('des')), lat=lat, lon=lon,
                          headingDeg=heading % 360 if heading is not None and heading >= 0 else None,
                          speedMph=speed if speed is not None and speed >= 0 else None,
                          delayed=delay, passengerLoad=load if load in ('FULL', 'HALF_EMPTY', 'EMPTY') else None,
                          patternId=text(row.get('pid')))
    return list(buses.values())


class RTS:
    def __init__(self, client, key=None, routes_ttl=None, vehicles_ttl=None):
        self.client = client
        self.key = key if key is not None else os.getenv('RTS_API_KEY', '')
        self.base = os.getenv('RTS_BASE_URL', 'https://riderts.app/bustime/api/v3').rstrip('/')
        self.routes_ttl = max(1, float(routes_ttl if routes_ttl is not None else os.getenv('RTS_ROUTES_TTL_SECONDS', '3600')))
        self.vehicles_ttl = max(1, float(vehicles_ttl if vehicles_ttl is not None else os.getenv('RTS_VEHICLES_TTL_SECONDS', '30')))
        self.daily_limit = max(100, int(os.getenv('RTS_DAILY_REQUEST_LIMIT', '10000')))
        # Daily calls spent by other users of this client, such as the transit catalog.
        self.reserved_daily_calls = 0
        self.routes = []
        self.routes_at = float('-inf')
        self.attempt_at = float('-inf')
        self.buses = []
        self.fetched_at = None
        self.failed = False
        self.lock = asyncio.Lock()
        self.request_day = ''
        self.request_count = 0

    async def request(self, method, field, **params):
        if not self.key:
            raise ValueError('RTS not configured')
        day = datetime.now(timezone.utc).date().isoformat()
        if day != self.request_day:
            self.request_day, self.request_count = day, 0
        if self.request_count >= self.daily_limit:
            raise ValueError('RTS daily request budget exhausted')
        self.request_count += 1
        response = await self.client.get(f'{self.base}/{method}', params={'key': self.key, 'format': 'json', **params}, timeout=8)
        response.raise_for_status()
        body = response.json()['bustime-response']
        if not isinstance(body, dict):
            raise ValueError('Invalid RTS response')
        errors = body.get('error', [])
        # BusTime reports an inactive route as "No data found". Other errors must
        # fail the whole snapshot, even when a partial vehicle list is present.
        if errors:
            if field == 'vehicle' and isinstance(errors, list) and all(isinstance(e, dict) and str(e.get('msg', '')).strip().lower() in ('no data found', 'no data found for parameter', 'no data found for parameter(s)') for e in errors):
                errors = []
            if errors:
                raise ValueError('RTS upstream error')
        # Gainesville v3 uses plural `routes`; vehicle lists remain singular.
        rows = body.get('routes', body.get('route', [])) if field == 'route' else body.get(field, [])
        if not isinstance(rows, list):
            raise ValueError('Invalid RTS response')
        return rows

    async def snapshot(self):
        async with self.lock:
            now = time.monotonic()
            # Keep the configured cache interval, increasing it only when needed
            # to stay within the provider's daily request allowance. Reserve
            # both route catalogs, prediction headroom, and on-demand lookups.
            catalog_budget = math.ceil(86400 / self.routes_ttl) * (1 + len(self.routes)) + 500 + self.reserved_daily_calls
            batch_count = math.ceil(len(self.routes) / 10)
            interval = max(self.vehicles_ttl, batch_count * 86400 / max(1, self.daily_limit - catalog_budget))
            if now - self.attempt_at >= interval:
                try:
                    if now - self.routes_at >= self.routes_ttl:
                        rows = await self.request('getroutes', 'route')
                        routes = list(dict.fromkeys(text(r.get('rt')) for r in rows if isinstance(r, dict) and text(r.get('rt'))))
                        if not routes:
                            raise ValueError('Empty route catalog')
                        self.routes, self.routes_at = routes, time.monotonic()
                    rows = []
                    for i in range(0, len(self.routes), 10):
                        rows.extend(await self.request('getvehicles', 'vehicle', rt=','.join(self.routes[i:i+10])))
                    self.buses = normalize(rows)
                    self.fetched_at = datetime.now(timezone.utc).isoformat()
                    self.failed = False
                except (httpx.HTTPError, ValueError, KeyError, TypeError):
                    self.failed = True
                finally:
                    self.attempt_at = time.monotonic()
            status = 'stale' if self.failed and self.fetched_at else 'unavailable' if self.failed else 'available'
            return self.buses, self.fetched_at, status
