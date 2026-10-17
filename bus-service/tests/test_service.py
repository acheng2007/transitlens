import asyncio
import time
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from app.main import app
from app.rts import RTS, normalize
from app.geo import haversine_km

ROW = dict(vid='2417', rt='38', lat='29.6481', lon='-82.3452', hdg='360', spd='18', des='Gainesville Place')


class NormalizationTests(unittest.TestCase):
    def test_nulls_units_duplicates_invalid_positions(self):
        rows = [ROW, ROW, {**ROW, 'vid': 'bad', 'lat': 'NaN'}, {**ROW, 'vid': 'bad2', 'lon': '181'},
                {**ROW, 'vid': 'unknown', 'spd': '-1', 'hdg': '-1', 'dly': 'unknown', 'psgld': 'N/A'},
                {**ROW, 'vid': 'stopped', 'spd': '0', 'dly': 'false', 'psgld': 'FULL'}]
        buses = normalize(rows)
        self.assertEqual(len(buses), 3)
        self.assertEqual(buses[0]['speedMph'], 18)
        self.assertEqual(buses[0]['headingDeg'], 0)
        self.assertIsNone(buses[0]['delayed'])
        for key in ('speedMph', 'headingDeg', 'delayed', 'passengerLoad'):
            self.assertIsNone(buses[1][key])
        self.assertEqual(buses[2]['speedMph'], 0)
        self.assertIs(buses[2]['delayed'], False)


class CacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_cache_single_refresh(self):
        calls = []
        async def upstream(request):
            calls.append(request)
            await asyncio.sleep(0.001)
            body = {'route': [{'rt': str(n)} for n in range(23)]} if request.url.path.endswith('getroutes') else {'vehicle': [ROW]}
            return httpx.Response(200, json={'bustime-response': body})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            results = await asyncio.gather(*(RTS.snapshot(rts) for rts in [RTS(client, key='test-secret')] * 6))
            self.assertEqual(len(calls), 4)
            self.assertTrue(all(len(r.url.params['rt'].split(',')) <= 10 for r in calls[1:]))
            self.assertTrue(all(r[2] == 'available' for r in results))
            self.assertEqual(len(results[0][0]), 1)

    async def test_failure_retains_complete_snapshot_and_recovers(self):
        mode = 'good'
        def upstream(request):
            if request.url.path.endswith('getroutes'):
                return httpx.Response(200, json={'bustime-response': {'route': [{'rt': str(i)} for i in range(11)]}})
            if mode == 'timeout':
                raise httpx.ReadTimeout('timeout', request=request)
            if mode == 'auth':
                return httpx.Response(200, json={'bustime-response': {'error': [{'msg': 'Invalid key'}]}})
            if mode == 'partial' and request.url.params['rt'] == '10':
                return httpx.Response(503)
            return httpx.Response(200, json={'bustime-response': {'vehicle': [] if mode == 'empty' else [ROW]}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            rts = RTS(client, key='test-secret')
            initial = await rts.snapshot()
            for failure in ('partial', 'timeout', 'auth'):
                mode = failure
                rts.attempt_at = float('-inf')
                result = await rts.snapshot()
                self.assertEqual(result[:2], initial[:2])
                self.assertEqual(result[2], 'stale')
            mode = 'empty'
            rts.attempt_at = float('-inf')
            result = await rts.snapshot()
            self.assertEqual(result[0], [])
            self.assertEqual(result[2], 'available')

    async def test_gainesville_plural_routes_catalog(self):
        def upstream(request):
            body = {'routes': [{'rt': '38'}]} if request.url.path.endswith('getroutes') else {'vehicle': [ROW]}
            return httpx.Response(200, json={'bustime-response': body})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            app.state.rts = RTS(client, key='test-secret')
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as api:
                data = (await api.get('/api/buses/nearby', params={'lat': 29.6465, 'lon': -82.3478})).json()
                self.assertEqual(data['status'], 'available')
                self.assertEqual(data['buses'][0]['route'], '38')

    async def test_active_and_inactive_routes_share_a_successful_batch(self):
        def upstream(request):
            body = {'routes': [{'rt': '38'}, {'rt': '21'}]} if request.url.path.endswith('getroutes') else {
                'vehicle': [ROW], 'error': [{'rt': '21', 'msg': 'No data found for parameter'}]}
            return httpx.Response(200, json={'bustime-response': body})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            app.state.rts = RTS(client, key='test-secret')
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as api:
                data = (await api.get('/api/buses/nearby', params={'lat': 29.6465, 'lon': -82.3478})).json()
                self.assertEqual(data['status'], 'available')
                self.assertEqual(len(data['buses']), 1)

    async def test_unavailable_without_credentials(self):
        async with httpx.AsyncClient() as client:
            self.assertEqual(await RTS(client, key='').snapshot(), ([], None, 'unavailable'))

    async def test_no_data_is_successful_empty(self):
        def upstream(request):
            body = {'route': [{'rt': '38'}]} if request.url.path.endswith('getroutes') else {'error': [{'msg': 'No data found for parameter(s)'}]}
            return httpx.Response(200, json={'bustime-response': body})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            app.state.rts = RTS(client, key='test-secret')
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as api:
                response = await api.get('/api/buses/nearby', params={'lat': 29.6465, 'lon': -82.3478})
                self.assertEqual(response.json()['status'], 'available')
                self.assertEqual(response.json()['buses'], [])

    async def test_route_cache_one_hour(self):
        routes = 0
        def upstream(request):
            nonlocal routes
            if request.url.path.endswith('getroutes'):
                routes += 1
                return httpx.Response(200, json={'bustime-response': {'route': [{'rt': '38'}]}})
            return httpx.Response(200, json={'bustime-response': {'vehicle': []}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            rts = RTS(client, key='test-secret')
            for clock in (0, 31, 3599, 3631):
                with patch('app.rts.time.monotonic', return_value=clock):
                    await rts.snapshot()
            self.assertEqual(routes, 2)


class EndpointTests(unittest.TestCase):
    def test_radius_cone_wraparound_and_empty(self):
        with TestClient(app) as client:
            rts = app.state.rts
            rts.buses = normalize([{**ROW, 'lat': 29.65, 'lon': -82.3478}])
            rts.fetched_at = '2026-10-16T00:00:00+00:00'
            rts.attempt_at = time.monotonic()
            params = dict(lat=29.6465, lon=-82.3478, heading=359, fovDeg=2)
            data = client.get('/api/buses/nearby', params=params).json()
            self.assertEqual(len(data['buses']), 1)
            self.assertAlmostEqual(data['buses'][0]['offsetDeg'], 1)
            self.assertFalse(data['demo'])
            self.assertIsNotNone(data['magneticDeclinationDeg'])
            params['radiusKm'] = haversine_km(29.6465, -82.3478, 29.65, -82.3478)
            self.assertEqual(len(client.get('/api/buses/nearby', params=params).json()['buses']), 1)
            params['radiusKm'] -= 0.0001
            self.assertEqual(client.get('/api/buses/nearby', params=params).json()['buses'], [])
            for invalid in ({'lat': 100}, {'heading': 360}, {'fovDeg': 0}, {'radiusKm': -1}):
                self.assertEqual(client.get('/api/buses/nearby', params={**params, **invalid}).status_code, 422)

    def test_missing_key_envelope(self):
        with patch.dict('os.environ', {'RTS_API_KEY': ''}), TestClient(app) as client:
            result = client.get('/api/buses/nearby', params=dict(lat=29.6465, lon=-82.3478))
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()['status'], 'unavailable')
            self.assertIsNone(result.json()['fetchedAt'])
            self.assertNotIn('key', result.text.lower())


if __name__ == '__main__':
    unittest.main()
