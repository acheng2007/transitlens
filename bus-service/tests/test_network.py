import asyncio
import unittest
from unittest.mock import AsyncMock
from app.network import Network, normalize_pattern, plan_direct
from app.rts import RTS
import httpx


def pattern(direction='OUTBOUND', reverse=False):
    stops = [dict(id='board', name='Reitz Union', lat=29.6465, lon=-82.3478, sequence=0),
             dict(id='target', name='Shands Hospital', lat=29.639, lon=-82.344, sequence=1)]
    if reverse:
        stops = [{**stops[1], 'sequence': 0}, {**stops[0], 'sequence': 1}]
    return dict(id='38:585', patternId='585', routeId='38', name='Test route', color='#55aaee', direction=direction,
                stops=stops, shape=[dict(lat=s['lat'],lon=s['lon']) for s in stops])


def network(*patterns):
    return dict(demo=False, status='available', fetchedAt='2026-10-16T00:00:00Z', patterns=list(patterns))


class PlanningTests(unittest.TestCase):
    def test_direction_and_order_reject_reverse_trip(self):
        forward=plan_direct(network(pattern()),'Shands',29.6465,-82.3478)
        reverse=plan_direct(network(pattern(reverse=True)),'Shands',29.6465,-82.3478)
        self.assertEqual(forward['options'][0]['routeId'],'38')
        self.assertEqual(forward['options'][0]['walkKm'],0)
        self.assertEqual(reverse['status'],'no_direct_routes')

    def test_unknown_ambiguous_and_far_boarding(self):
        p=pattern()
        self.assertEqual(plan_direct(network(p),'nonexistent',29.6465,-82.3478)['status'],'not_found')
        self.assertEqual(plan_direct(network(p),'Shands',30,-83)['status'],'no_direct_routes')
        other={**p,'stops':[{**p['stops'][1],'id':'far','lat':30,'name':'Shands Clinic'}]}
        self.assertEqual(plan_direct(network(p,other),'Shands',29.6465,-82.3478)['status'],'ambiguous')

    def test_loop_can_reach_a_later_occurrence_without_reversing_stops(self):
        p=pattern(reverse=True)
        p['stops'].append({**pattern()['stops'][1],'sequence':2})
        p['shape'].append(p['shape'][0])
        self.assertEqual(plan_direct(network(p),'Shands',29.6465,-82.3478)['options'][0]['rideStops'],1)

    def test_invalid_coordinates_and_unordered_provider_points(self):
        row=dict(pid=1,rtdir='OUTBOUND',pt=[dict(seq=2,typ='W',lat=29.64,lon=-82.34),dict(seq=1,typ='S',stpid='x',stpnm='Stop',lat=29.65,lon=-82.35),dict(seq=3,lat='NaN',lon=-82)])
        p=normalize_pattern(dict(rt='38',rtnm='Test',rtclr='javascript:bad'),row)
        self.assertEqual(p['stops'][0]['sequence'],0)
        self.assertEqual(len(p['shape']),2)
        self.assertEqual(p['color'],'#5ce1e6')


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_prediction_requires_matching_direction_route_and_stop(self):
        rts=type('Fake',(),{})()
        rts.request=AsyncMock(return_value=[dict(rt='38',stpid='board',rtdir='INBOUND',prdctdn='1'),
            dict(rt='38',stpid='board',rtdir='OUTBOUND',prdctdn='5',vid='x'),
            dict(rt='9',stpid='board',rtdir='OUTBOUND',prdctdn='0')])
        n=Network(rts)
        result=await n.arrivals('board','38','OUTBOUND')
        self.assertEqual(result['minutes'],5)
        self.assertEqual((await n.arrivals('board','38','OUTBOUND'))['minutes'],5)
        self.assertEqual(rts.request.await_count,1)

    async def test_catalog_concurrency_and_partial_snapshot_cache(self):
        rts=type('Fake',(),{})()
        row=dict(pid=1,rtdir='OUTBOUND',pt=[dict(seq=1,typ='S',stpid='x',stpnm='Stop',lat=29.65,lon=-82.35),dict(seq=2,typ='W',lat=29.64,lon=-82.34)])
        async def request(method,field,**params):
            if method=='getroutes': return [dict(rt='38'),dict(rt='99')]
            if params['rt']=='99': raise ValueError('unavailable')
            return [row]
        rts.request=AsyncMock(side_effect=request)
        n=Network(rts)
        results=await asyncio.gather(n.snapshot(),n.snapshot(),n.snapshot())
        self.assertEqual(results[0]['status'],'partial')
        self.assertEqual(rts.request.await_count,3)
        rts.request=AsyncMock(side_effect=ValueError('failed'))
        n.attempt_at=float('-inf')
        self.assertEqual((await n.snapshot())['status'],'stale')
        self.assertEqual(len(n.cached['patterns']),1)

    async def test_daily_budget_applies_to_patterns_and_predictions(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'bustime-response':{'ptr':[]}}))) as client:
            rts=RTS(client,key='test-secret')
            from datetime import datetime,timezone
            rts.request_day=datetime.now(timezone.utc).date().isoformat()
            rts.request_count=rts.daily_limit
            with self.assertRaisesRegex(ValueError,'budget'):
                await rts.request('getpatterns','ptr',rt='38')

    async def test_demo_fixture_is_explicit_and_never_contacts_provider(self):
        rts=type('Fake',(),{})();rts.request=AsyncMock(side_effect=RuntimeError('must not call'))
        data=await Network(rts).snapshot(True)
        self.assertTrue(data['demo'])
        self.assertEqual(len({p['routeId'] for p in data['patterns']}),6)
        rts.request.assert_not_awaited()
