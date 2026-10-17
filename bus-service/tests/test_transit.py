import time
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.rts import RTS, normalize
from app.transit import KM_PER_FOOT, TransitCatalog, normalize_pattern

ROUTES = [{'rt': '9', 'rtdd': '9', 'rtnm': 'Reitz Loop', 'rtclr': '#123abc'},
          {'rt': '20', 'rtdd': '20', 'rtnm': 'Crosstown', 'rtclr': 'red'}]


def point(seq, lat, lon, stop=None, name=None, pdist=0.0):
    p = {'seq': seq, 'lat': lat, 'lon': lon, 'typ': 'S' if stop else 'W', 'pdist': pdist}
    if stop:
        p.update(stpid=stop, stpnm=name)
    return p


# Route 9 runs A -> B -> C; route 20 has opposite directions over B and C.
PATTERNS = {
    '9': [{'pid': 100, 'ln': 10000.0, 'rtdir': 'INBOUND', 'pt': [
        point(3, 29.650, -82.345, '0003', 'Shands Hospital', 6000),
        point(1, 29.640, -82.350, '0001', 'Reitz Union', 0),
        point(2, 29.645, -82.348, None),
        point(4, 29.646, -82.347, '0002', 'Museum Rd', 3000),
    ]}],
    '20': [
        {'pid': 200, 'ln': 5000.0, 'rtdir': 'EASTBOUND', 'pt': [
            point(1, 29.646, -82.347, '0002', 'Museum Rd', 0),
            point(2, 29.650, -82.345, '0003', 'Shands Hospital', 2000)]},
        {'pid': 201, 'ln': 5000.0, 'rtdir': 'WESTBOUND', 'dtrid': '77', 'pt': [
            point(1, 29.650, -82.345, '0003', 'Shands Hospital', 0),
            point(2, 29.646, -82.347, '0002', 'Museum Rd', 2000)]},
    ],
}
ON_DEMAND = {'pid': 300, 'ln': 100.0, 'rtdir': 'OUTBOUND', 'pt': [
    point(1, 29.640, -82.350, '0001', 'Reitz Union', 0), point(2, 29.641, -82.351, '0009', 'Hub', 100)]}


def upstream(calls, fail=lambda request: False):
    def handler(request):
        calls.append(request)
        if fail(request):
            return httpx.Response(503)
        method = request.url.path.rsplit('/', 1)[-1]
        params = request.url.params
        if method == 'getroutes':
            body = {'routes': ROUTES}
        elif method == 'getpatterns' and 'pid' in params:
            body = {'ptr': [ON_DEMAND]} if params['pid'] == '300' else {'error': [{'msg': 'No data found'}]}
        elif method == 'getpatterns':
            body = {'ptr': PATTERNS[params['rt']]}
        else:
            body = {'vehicle': [{'vid': 'v1', 'rt': '20', 'lat': 29.646, 'lon': -82.347, 'pid': 200},
                                {'vid': 'v2', 'rt': '9', 'lat': 29.64, 'lon': -82.35, 'pid': 300}]}
        return httpx.Response(200, json={'bustime-response': body})
    return handler


class NormalizationTests(unittest.TestCase):
    def test_pattern_order_units_stops_and_invalid_rows(self):
        pattern = normalize_pattern(PATTERNS['9'][0], '9')
        self.assertEqual(pattern['id'], '100')
        self.assertEqual([s['id'] for s in pattern['stops']], ['0001', '0003', '0002'])
        self.assertEqual([s['sequence'] for s in pattern['stops']], [0, 1, 2])
        self.assertEqual(len(pattern['points']), 4)
        self.assertAlmostEqual(pattern['lengthKm'], 10000 * KM_PER_FOOT)
        self.assertAlmostEqual(pattern['stops'][1]['distanceKm'], 6000 * KM_PER_FOOT)
        self.assertFalse(pattern['detour'])
        self.assertTrue(normalize_pattern(PATTERNS['20'][1], '20')['detour'])
        self.assertIsNone(normalize_pattern({'pid': 1, 'pt': [point(1, 0, 0, '1', 'Null Island')]}, '1'))
        self.assertIsNone(normalize_pattern({'pt': []}, '1'))

    def test_vehicle_pattern_id_is_nullable(self):
        rows = normalize([{'vid': '1', 'rt': '9', 'lat': 29.6, 'lon': -82.3, 'pid': 100},
                          {'vid': '2', 'rt': '9', 'lat': 29.6, 'lon': -82.3}])
        self.assertEqual([r['patternId'] for r in rows], ['100', None])


class CatalogTests(unittest.IsolatedAsyncioTestCase):
    async def catalog(self, calls, **kwargs):
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream(calls, **kwargs)))
        self.addAsyncCleanup(client.aclose)
        return TransitCatalog(RTS(client, key='test-secret'), ttl=86400)

    async def test_stops_share_routes_and_colors_are_validated(self):
        catalog = await self.catalog([])
        await catalog.ensure()
        self.assertEqual(catalog.status(), 'available')
        self.assertEqual(catalog.routes['9']['color'], '#123abc')
        self.assertIsNone(catalog.routes['20']['color'])
        museum = catalog.stops['0002']['routes']
        self.assertEqual({(s['routeId'], s['direction']) for s in museum},
                         {('9', 'INBOUND'), ('20', 'EASTBOUND'), ('20', 'WESTBOUND')})
        self.assertEqual(catalog.route_summary(catalog.routes['20'])['directions'], ['EASTBOUND', 'WESTBOUND'])

    async def test_direct_service_respects_direction_and_order(self):
        catalog = await self.catalog([])
        await catalog.ensure()
        options = catalog.direct_options({'0002': None}, {'0003': None}, {('20', 'EASTBOUND'): 2}, 5)
        self.assertEqual([(o['routeId'], o['direction']) for o in options], [('20', 'EASTBOUND')])
        self.assertEqual(options[0]['activeVehicleCount'], 2)
        self.assertAlmostEqual(options[0]['rideKm'], 2000 * KM_PER_FOOT)
        reverse = catalog.direct_options({'0003': None}, {'0002': None}, {}, 5)
        self.assertEqual({(o['routeId'], o['direction']) for o in reverse}, {('9', 'INBOUND'), ('20', 'WESTBOUND')})
        self.assertTrue(next(o for o in reverse if o['routeId'] == '20')['detour'])
        self.assertEqual(catalog.direct_options({'0001': None}, {'0001': None}, {}, 5), [])

    async def test_direct_service_ranks_shorter_straight_line_walks_first(self):
        catalog = await self.catalog([])
        await catalog.ensure()
        options = catalog.direct_options({'0001': 0.5, '0002': 0.1}, {'0003': 0.0}, {}, 5)
        self.assertEqual([o['boardStop']['id'] for o in options], ['0002', '0001'])

    async def test_search_returns_candidates_without_guessing(self):
        catalog = await self.catalog([])
        await catalog.ensure()
        self.assertEqual([s['id'] for s in catalog.search_stops('shands', 10)], ['0003'])
        self.assertEqual([s['id'] for s in catalog.search_stops('REITZ union!', 10)], ['0001'])
        self.assertEqual(catalog.search_stops('nowhere', 10), [])

    async def test_failure_keeps_last_good_catalog_and_waits_before_retrying(self):
        calls, failing = [], False
        catalog = await self.catalog(calls, fail=lambda request: failing)
        await catalog.ensure()
        before = len(calls)
        failing = True
        catalog.loaded_at = float('-inf')
        catalog.attempt_at = float('-inf')
        await catalog.ensure()
        self.assertEqual(catalog.status(), 'stale')
        self.assertIn('0001', catalog.stops)
        attempts = len(calls)
        await catalog.ensure()
        self.assertEqual(len(calls), attempts)
        self.assertGreater(attempts, before)

    async def test_unavailable_without_any_successful_load(self):
        catalog = await self.catalog([], fail=lambda request: True)
        await catalog.ensure()
        self.assertEqual(catalog.status(), 'unavailable')

    async def test_unknown_patterns_are_fetched_only_for_live_vehicles_and_once(self):
        calls = []
        catalog = await self.catalog(calls)
        await catalog.ensure()
        loaded = len(calls)
        self.assertIsNone(await catalog.pattern('300', {}))
        self.assertEqual(len(calls), loaded)
        pattern = await catalog.pattern('300', {'300': '9'})
        self.assertEqual(pattern['direction'], 'OUTBOUND')
        self.assertIn('0009', catalog.stops)
        self.assertIsNone(await catalog.pattern('404', {'404': '9'}))
        self.assertIsNone(await catalog.pattern('404', {'404': '9'}))
        self.assertEqual(len(calls), loaded + 2)

    def test_catalog_calls_are_reserved_from_the_vehicle_budget(self):
        catalog = TransitCatalog(None, ttl=86400)
        self.assertEqual(catalog.daily_calls(27), 28 + 300)

    async def test_vehicle_refresh_interval_accounts_for_reserved_calls(self):
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream([])))
        self.addAsyncCleanup(client.aclose)
        with patch.dict('os.environ', {'RTS_DAILY_REQUEST_LIMIT': '400'}):
            rts = RTS(client, key='test-secret', vehicles_ttl=1)
        rts.routes, rts.routes_at = [str(n) for n in range(30)], time.monotonic()
        rts.reserved_daily_calls = 300
        await rts.snapshot()
        refreshed = rts.attempt_at
        with patch('app.rts.time.monotonic', return_value=refreshed + 3000):
            await rts.snapshot()
        self.assertEqual(rts.attempt_at, refreshed)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.client = TestClient(app)
        self.client.__enter__()
        mock = httpx.AsyncClient(transport=httpx.MockTransport(upstream(self.calls)))
        app.state.rts = RTS(mock, key='test-secret')
        app.state.transit = TransitCatalog(app.state.rts, ttl=86400)

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def get(self, path, **params):
        return self.client.get(path, params=params)

    def test_route_pattern_and_stop_lookups(self):
        routes = self.get('/api/transit/routes').json()
        self.assertEqual(routes['status'], 'available')
        self.assertIsNotNone(routes['fetchedAt'])
        self.assertEqual([r['id'] for r in routes['routes']], ['20', '9'])
        route = self.get('/api/transit/routes/20').json()['route']
        self.assertEqual([p['direction'] for p in route['patterns']], ['EASTBOUND', 'WESTBOUND'])
        pattern = self.get('/api/transit/patterns/100').json()['pattern']
        self.assertEqual((pattern['routeDisplay'], pattern['routeColor']), ('9', '#123abc'))
        self.assertEqual(self.get('/api/transit/patterns/300').json()['pattern']['routeId'], '9')
        for path in ('/api/transit/routes/99', '/api/transit/patterns/999'):
            self.assertEqual(self.get(path).status_code, 404)
        self.assertEqual(self.get('/api/transit/routes/bad%20id').status_code, 422)

    def test_nearby_and_search(self):
        nearby = self.get('/api/transit/stops/nearby', lat=29.640, lon=-82.350, radiusKm=0.1).json()
        self.assertEqual([s['id'] for s in nearby['stops']], ['0001'])
        self.assertEqual(nearby['stops'][0]['distanceKm'], 0)
        far = self.get('/api/transit/stops/nearby', lat=29.640, lon=-82.350, radiusKm=5).json()['stops']
        self.assertEqual([s['id'] for s in far], ['0001', '0002', '0003'])
        self.assertEqual(self.get('/api/transit/stops/nearby', lat=29.6, lon=-82.3, radiusKm=6).status_code, 422)
        self.assertEqual(self.get('/api/transit/stops/search', q='s').status_code, 422)
        self.assertEqual(self.get('/api/transit/stops/search', q='museum').json()['stops'][0]['id'], '0002')

    def test_direct_from_coordinates_labels_approximate_guidance(self):
        data = self.get('/api/transit/direct', fromLat=29.6401, fromLon=-82.3501, toStopId='0003', radiusKm=0.2).json()
        self.assertEqual(data['coverage'], 'direct-service')
        self.assertTrue(any('transfers' in line for line in data['limitations']))
        option = data['options'][0]
        self.assertEqual((option['routeId'], option['boardStop']['id']), ('9', '0001'))
        self.assertEqual(option['approachToBoarding']['note'], 'approximate direction, not a walking route')
        self.assertGreater(option['approachToBoarding']['distanceKm'], 0)
        self.assertIsNone(option['alightingToDestination'])
        self.assertEqual(option['activeVehicleCount'], 0)

    def test_direct_counts_vehicles_operating_on_the_matching_direction(self):
        data = self.get('/api/transit/direct', fromStopId='0002', toLat=29.650, toLon=-82.345).json()
        option = data['options'][0]
        self.assertEqual((option['routeId'], option['direction'], option['activeVehicleCount']), ('20', 'EASTBOUND', 1))
        self.assertIsNone(option['approachToBoarding'])
        self.assertEqual(option['alightingToDestination']['distanceKm'], 0)

    def test_direct_validation_and_unknown_stops(self):
        for params in ({'toStopId': '0003'}, {'fromStopId': '0001', 'fromLat': 29.6, 'fromLon': -82.3, 'toStopId': '0003'},
                       {'fromLat': 29.6, 'toStopId': '0003'}, {'fromStopId': '../x', 'toStopId': '0003'}):
            self.assertEqual(self.get('/api/transit/direct', **params).status_code, 422)
        self.assertEqual(self.get('/api/transit/direct', fromStopId='nope', toStopId='0003').status_code, 404)
        self.assertEqual(self.get('/api/transit/direct', fromStopId='0001', toStopId='0001').json()['options'], [])

    def test_missing_catalog_is_unavailable_not_unknown(self):
        with patch.dict('os.environ', {'RTS_API_KEY': ''}):
            app.state.rts = RTS(httpx.AsyncClient())
            app.state.transit = TransitCatalog(app.state.rts)
        listing = self.get('/api/transit/routes')
        self.assertEqual((listing.status_code, listing.json()['status'], listing.json()['routes']), (200, 'unavailable', []))
        self.assertEqual(self.get('/api/transit/routes/9').status_code, 503)
        self.assertEqual(self.get('/api/transit/direct', fromStopId='0001', toStopId='0003').status_code, 503)
        self.assertNotIn('key', listing.text.lower())


if __name__ == '__main__':
    unittest.main()
