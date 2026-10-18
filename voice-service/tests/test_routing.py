"""Offline transcript-to-HTTP-to-validated-action tests against the real bus API."""
import asyncio
import importlib
import json
from pathlib import Path
import sys
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException

import main
from intents import Intent, local_intent
from request_cache import RequestCache

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'bus-service'))
bus_api = importlib.import_module('app.main')
from app.demo import buses as demo_buses
from app.network import FIXTURE


@pytest.fixture
def grounded_api(monkeypatch):
    catalog = json.loads(FIXTURE.read_text()) | {'status': 'available', 'demo': True}
    rows = demo_buses()
    network = type('Network', (), {})()
    network.snapshot = AsyncMock(return_value=catalog)
    network.arrivals = AsyncMock(return_value=dict(status='demo', minutes=4, vehicleId=None, fetchedAt=None, label='Scripted arrival'))
    bus_api.app.state.network = network
    original = httpx.AsyncClient
    transport = httpx.ASGITransport(app=bus_api.app)
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: original(**kw, transport=transport))
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    return catalog, rows


def request(question, **context):
    return main.AskRequest(requestId='routing-test', question=question, context={
        'dataMode': 'demo', 'position': {'lat': 29.6465, 'lon': -82.3478}, **context})


@pytest.mark.asyncio
async def test_bus_stop_query_round_trip_uses_exact_vehicle_and_grounded_stop(grounded_api):
    catalog, rows = grounded_api
    bus = rows[0]
    p = next(p for p in catalog['patterns'] if p['patternId'] == bus['patternId'])
    stop = p['stops'][-1]
    reply = await main.guarded_ask(request(f"How far is vehicle {bus['id']} from {stop['id']}"))
    assert reply.source == 'scripted'
    action = reply.actions[0]
    assert action.type == 'show_bus_stop'
    assert action.result.stop.id == stop['id']
    assert [v.busId for v in action.result.vehicles] == [bus['id']]
    assert 'straight-line' in reply.answer
    assert action.result.demo


@pytest.mark.asyncio
async def test_take_me_recommends_a_grounded_stop_and_followup_retains_destination(grounded_api):
    first = await main.guarded_ask(request('Take me to Shands'))
    plan = next(a.plan for a in first.actions if a.type == 'show_journeys')
    assert plan.options
    assert plan.recommendedJourneyId in [o.id for o in plan.options]
    guidance = next(a.journey for a in first.actions if a.type == 'start_guidance')
    assert guidance.id == plan.recommendedJourneyId
    followup = await main.guarded_ask(request('Take the first option', destinationQuery=plan.query))
    assert any(a.type == 'start_guidance' for a in followup.actions)
    shorter = await main.guarded_ask(request('Less walking', destinationQuery=plan.query, selectedJourneyId='old-choice'))
    assert any(a.type == 'start_guidance' for a in shorter.actions)


@pytest.mark.asyncio
async def test_route_details_and_explicit_onboard_selection_are_separate(grounded_api):
    catalog, rows = grounded_api
    bus = rows[0]
    details = await main.guarded_ask(request('Tell me more about this route', focusedBusId=bus['id']))
    assert any(a.type == 'show_routes' for a in details.actions)
    assert not any(a.type == 'set_onboard_bus' for a in details.actions)
    followup = await main.guarded_ask(request('Tell me more about that route', selectedRouteId=bus['route'], destinationQuery='Shands'))
    assert not followup.actions
    boarding = await main.guarded_ask(request(f"I am on vehicle {bus['id']}"))
    assert boarding.actions[0].bus.id == bus['id']
    cleared = await main.guarded_ask(request('I got off the bus', onboardBusId=bus['id']))
    assert cleared.actions[0].bus is None


@pytest.mark.asyncio
async def test_unspecified_onboard_and_unknown_vehicle_never_guess(grounded_api):
    reply = await main.guarded_ask(request('How can I get to Reitz Union from where I am on the bus'))
    assert 'Which route' in reply.answer
    assert reply.actions == []
    reply = await main.guarded_ask(request('I am on vehicle made-up'))
    assert reply.actions == []
    assert 'not available' in reply.answer


@pytest.mark.asyncio
async def test_stop_clarification_and_multiple_onboard_vehicles_require_a_choice(grounded_api):
    catalog, rows = grounded_api
    p = catalog['patterns'][0]
    p['stops'][1]['id'] = 'test-east'
    p['stops'][2]['id'] = 'test-west'
    p['stops'][1]['name'] = 'Test Stop East'
    p['stops'][2]['name'] = 'Test Stop West'
    reply = await main.guarded_ask(request(f"How far is route {p['routeId']} from Test Stop"))
    result = reply.actions[0].result
    assert result.status == 'ambiguous' and not result.vehicles
    reply = await main.guarded_ask(request('the second stop', busStopQuery='Test Stop', selectedRouteId=p['routeId']))
    assert reply.actions[0].result.stop.id == result.stops[1].id
    # Demo has multiple route 9 vehicles. A route number alone must never imply a unique onboard bus.
    route = rows[0]['route']
    assert sum(v['route'] == route for v in rows) > 1
    reply = await main.guarded_ask(request(f'I am on route {route}'))
    assert reply.actions[0].type == 'show_bus_choices'
    assert not any(a.type == 'set_onboard_bus' for a in reply.actions)


@pytest.mark.asyncio
async def test_stale_catalog_does_not_confirm_progress_or_onboard_trip(grounded_api):
    catalog, rows = grounded_api
    catalog['status'] = 'stale'
    p = catalog['patterns'][0]
    reply = await main.guarded_ask(request(f"How far is route {p['routeId']} from {p['stops'][-1]['id']}"))
    assert all(v.progress == 'unknown' and v.alongRouteKm is None for v in reply.actions[0].result.vehicles)
    reply = await main.guarded_ask(request('Take me to Shands', onboardBusId=rows[0]['id']))
    assert not reply.actions
    assert 'fresh vehicle data' in reply.answer


@pytest.mark.asyncio
async def test_keyed_natural_phrase_uses_one_decision_then_real_transit_tools(grounded_api, monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    decide = AsyncMock(return_value=Intent(scope='allow', intent='bus_stop_distance', routeId='38', stopQuery='Shands'))
    monkeypatch.setattr(main, 'generate_json', decide)
    reply = await main.guarded_ask(request('How far are the thirty eight buses from the Shands stop?'))
    assert reply.source == 'gemini'
    assert reply.actions[0].type == 'show_bus_stop'
    decide.assert_awaited_once()


@pytest.mark.asyncio
async def test_request_retries_share_work_and_reused_ids_cannot_change_question():
    cache = RequestCache()
    req = request('Take me to Reitz Union', sessionId='test-session')
    release = asyncio.Event()
    calls = 0
    async def operation():
        nonlocal calls
        calls += 1
        await release.wait()
        return 'response'
    tasks = [asyncio.create_task(cache.run(req, operation)) for _ in range(3)]
    await asyncio.sleep(0)
    release.set()
    assert await asyncio.gather(*tasks) == ['response'] * 3
    assert calls == 1
    changed = req.model_copy(update={'question': 'Different question'})
    with pytest.raises(HTTPException) as failure:
        await cache.run(changed, operation)
    assert failure.value.status_code == 409


def test_stop_followups_and_less_walking_have_bounded_explicit_intents():
    context = main.Context(busStopQuery='Tigert Hall', selectedRouteId='1', destinationQuery='Reitz Union')
    assert local_intent('the second stop', context).choice == 2
    assert local_intent('how far is it now', context).busTarget == 'selected'
    assert local_intent('less walking', context).preference == 'less_walking'
    assert local_intent('take me there', context).destination is None
    assert local_intent('take me here', main.Context()).scope == 'clarify'
    assert local_intent('How far is bus 1 from that stop', context).stopQuery is None


@pytest.mark.asyncio
async def test_supported_complete_routing_commands_work_during_provider_cooldown(grounded_api, monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    main.text_budget.cooldown('60')
    generation = AsyncMock(side_effect=AssertionError('No provider call expected'))
    monkeypatch.setattr(main, 'generate_json', generation)
    reply = await main.guarded_ask(request('Take me to Shands'))
    assert reply.source == 'scripted'
    assert any(a.type == 'start_guidance' for a in reply.actions)
    generation.assert_not_awaited()
