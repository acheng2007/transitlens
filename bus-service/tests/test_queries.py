import asyncio
import unittest
from unittest.mock import AsyncMock

from app.network import Network, plan_direct
from app.queries import progress_on_pattern, vehicle_at_stop, stop_query, route_details


def point(x):
    return dict(lat=29.6465, lon=-82.35 + x)


def pattern():
    shape = [point(i * 0.01) for i in range(4)]
    stops = [dict(id=f'000{i}', name=f'Stop {i}', sequence=i, **p) for i, p in enumerate(shape)]
    return dict(id='1:p1', routeId='1', patternId='p1', direction='OUTBOUND', name='Route 1',
                color='#123456', shape=shape, stops=stops)


def vehicle(x=0.005, **fields):
    return dict(id='v1', route='1', patternId='p1', headingDeg=None, speedMph=None, destination='Stop 3', **point(x)) | fields


def network():
    return dict(patterns=[pattern()], status='available', fetchedAt='2026-10-17T19:00:00Z', demo=False)


class QueryTests(unittest.TestCase):
    def test_approaching_passed_and_unknown_are_distinct(self):
        p = pattern()
        approaching = vehicle_at_stop(vehicle(), p['stops'][1], [p])
        self.assertEqual(approaching['progress'], 'approaching')
        self.assertAlmostEqual(approaching['distanceKm'], approaching['alongRouteKm'], places=3)
        passed = vehicle_at_stop(vehicle(0.015), p['stops'][1], [p])
        self.assertEqual(passed['progress'], 'passed')
        self.assertIsNone(passed['alongRouteKm'])
        unknown = vehicle_at_stop(vehicle(patternId='unknown'), p['stops'][1], [p])
        self.assertEqual(unknown['progress'], 'unknown')
        self.assertIsNone(unknown['prediction'])

    def test_projection_rejects_offroad_reverse_heading_and_loops(self):
        p = pattern()
        self.assertIsNone(progress_on_pattern(vehicle(lat=29.65), p)[0])
        self.assertIsNone(progress_on_pattern(vehicle(headingDeg=270, speedMph=15), p)[0])
        loop = {**p, 'shape': [point(0), point(0.01), point(0.02), point(0), point(0.01)]}
        self.assertIsNone(progress_on_pattern(vehicle(), loop)[0])

    def test_stop_not_served_and_ambiguous_names_never_guess(self):
        p = pattern()
        other = {**p['stops'][1], 'id': 'other'}
        self.assertEqual(vehicle_at_stop(vehicle(), other, [p])['progress'], 'not_served')
        n = network()
        n['patterns'][0]['stops'][1]['name'] = 'Tigert Hall East'
        n['patterns'][0]['stops'][2]['name'] = 'Tigert Hall West'
        result = stop_query(n, [vehicle()], 'Tigert Hall', route_id='1')
        self.assertEqual(result['status'], 'ambiguous')
        self.assertEqual(result['vehicles'], [])
        result = stop_query(n, [vehicle()], '0001', route_id='1')
        self.assertEqual(result['stop']['id'], '0001')
        self.assertEqual(result['vehicles'][0]['busId'], 'v1')
        self.assertEqual(stop_query(n, [vehicle()], '0001', route_id='99')['vehicles'], [])

    def test_onboard_only_plans_downstream_on_the_actual_pattern(self):
        bus = vehicle(0.015)
        n = network()
        result = plan_direct(n, '0003', 0, 0, [bus], onboard=bus)
        self.assertEqual(result['status'], 'available')
        self.assertTrue(result['options'][0]['onboard'])
        self.assertEqual(result['options'][0]['walkKm'], 0)
        self.assertEqual(plan_direct(n, '0001', 0, 0, [bus], onboard=bus)['status'], 'no_direct_routes')
        self.assertEqual(plan_direct(n, '0003', 0, 0, [bus], onboard=vehicle(patternId='other'))['options'], [])

    def test_active_count_and_next_stops_match_pattern_not_only_route(self):
        n = network()
        rows = [vehicle(), vehicle(id='v2', patternId='opposite')]
        plan = plan_direct(n, '0003', 29.6465, -82.35, rows)
        self.assertEqual(plan['options'][0]['activeVehicles'], 1)
        details = route_details(n, rows, bus_id='v1')
        self.assertEqual([s['id'] for s in details['nextStops']], ['0001', '0002', '0003'])
        self.assertEqual(route_details(n, rows, route_id='1', bus_id='invented')['routes'], [])

    def test_vehicle_predictions_match_vehicle_and_share_one_upstream_call(self):
        async def check():
            rts = type('RTS', (), {})()
            rts.request = AsyncMock(return_value=[
                dict(rt='1', rtdir='OUTBOUND', stpid='0001', vid='v1', prdctdn='5'),
                dict(rt='1', rtdir='OUTBOUND', stpid='0001', vid='v2', prdctdn='2')])
            n = Network(rts)
            a = await n.arrivals('0001', '1', 'OUTBOUND', vehicle_id='v1')
            b = await n.arrivals('0001', '1', 'OUTBOUND', vehicle_id='v2')
            self.assertEqual((a['minutes'], b['minutes']), (5, 2))
            self.assertEqual(rts.request.await_count, 1)
        asyncio.run(check())
