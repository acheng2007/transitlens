from datetime import datetime, timezone
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from google import genai
from google.genai import types

import main

BUS = dict(id='2417', route='38', destination='Gainesville Place', speedMph=None,
           delayed=None, passengerLoad=None, distanceKm=0.3, bearingDeg=20)
DATA = dict(status='available', fetchedAt=datetime.now(timezone.utc).isoformat(),
            focusedBus=BUS, previousBus=None, nearbyBuses=[BUS])
REQUEST = dict(requestId='test-1', question='Where is this bus going?', context={
    'focusedBusId': '2417', 'position': {'lat': 29.6465, 'lon': -82.3478}})


@pytest.mark.asyncio
async def test_authoritative_lookup_and_stale_ids(monkeypatch):
    real_client = httpx.AsyncClient
    def handler(request):
        assert request.url.path == '/api/buses/nearby'
        assert request.url.params['fovDeg'] == '360'
        return httpx.Response(200, json=dict(demo=False, status='available',
            fetchedAt=DATA['fetchedAt'], buses=[BUS]))
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    ctx = main.AskRequest(**REQUEST).context
    data = await main.transit_context(ctx)
    assert data['focusedBus']['destination'] == 'Gainesville Place'
    assert data['focusedBus']['delayed'] is None
    ctx.focusedBusId = 'fabricated'
    assert (await main.transit_context(ctx))['focusedBus'] is None
    ctx.position = None
    assert (await main.transit_context(ctx))['status'] == 'unavailable'


@pytest.mark.asyncio
async def test_data_failure_never_uses_client_facts(monkeypatch):
    real_client = httpx.AsyncClient
    def fail(request):
        raise httpx.ConnectError('private provider error', request=request)
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(fail), **kw))
    assert (await main.transit_context(main.AskRequest(**REQUEST).context))['nearbyBuses'] == []


@pytest.mark.parametrize('args', [{}, {'mode': 'invalid'}, {'extentKm': 0}, {'extentKm': float('inf')}, {'mode': 'expanded', 'url': 'bad'}])
def test_invalid_actions_are_atomic(args):
    result, actions = main.execute_tool('set_map_view', args, DATA)
    assert 'error' in result
    assert actions == []


@pytest.mark.asyncio
async def test_real_sdk_types_and_manual_tool_round_trip(monkeypatch):
    calls = []
    class FakeClient:
        def __init__(self, **kw):
            self.aio = self
            self.models = self
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def generate_content(self, **kw):
            calls.append(kw)
            if len(calls) == 1:
                assert kw['config'].tool_config.function_calling_config.mode == 'ANY'
                content = types.Content(role='model', parts=[types.Part.from_function_call(name='get_transit_context', args={})])
            elif len(calls) == 2:
                assert kw['contents'][-1].parts[0].function_response.response['focusedBus']['id'] == '2417'
                content = types.Content(role='model', parts=[types.Part.from_function_call(name='set_map_view', args={'mode': 'expanded', 'extentKm': 2.5})])
            else:
                content = types.Content(role='model', parts=[types.Part.from_text(text='Preparing your map.')])
            return types.GenerateContentResponse(candidates=[types.Candidate(content=content)])
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    monkeypatch.setattr(genai, 'Client', FakeClient)
    answer, actions = await main.ask_gemini(main.AskRequest(**REQUEST), DATA)
    assert answer == 'Preparing your map.'
    assert [a.model_dump() for a in actions] == [dict(type='set_map_mode', mode='expanded'), dict(type='set_map_extent', extentKm=2.5)]
    assert len(calls) == 3


def test_endpoint_missing_key_failure_and_schema(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.setattr(main, 'transit_context', AsyncMock(return_value=DATA))
    client = TestClient(main.app)
    response = client.post('/api/voice/ask', json=REQUEST)
    assert response.status_code == 200
    assert response.json()['source'] == 'local'
    assert 'Gainesville Place' in response.json()['answer']
    assert response.json()['actions'] == []
    assert response.json()['requestId'] == 'test-1'
    for bad in [{**REQUEST, 'question': '   '}, {**REQUEST, 'context': {'bus': BUS}}, {**REQUEST, 'history': [{'question': 'x', 'answer': 'y'}] * 5}]:
        assert client.post('/api/voice/ask', json=bad).status_code == 422
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    monkeypatch.setattr(main, 'ask_gemini', AsyncMock(side_effect=TimeoutError('secret error')))
    assert client.post('/api/voice/ask', json=REQUEST).json()['source'] == 'local'


def test_unknown_destination_and_stale_data_are_explicit():
    answer = main.local_answer({**DATA, 'status': 'stale', 'focusedBus': {**BUS, 'destination': None}})
    assert 'not reported' in answer
    assert 'outdated' in answer


@pytest.mark.asyncio
async def test_old_snapshot_marked_stale_and_unknown_tools_rejected(monkeypatch):
    real_client = httpx.AsyncClient
    def old(request):
        return httpx.Response(200, json=dict(demo=False, status='available',
            fetchedAt='2020-01-01T00:00:00+00:00', buses=[BUS]))
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(old), **kw))
    data = await main.transit_context(main.AskRequest(**REQUEST).context)
    assert data['status'] == 'stale'
    assert main.execute_tool('highlight_routes', {'route': '38'}, data)[1] == []


@pytest.mark.asyncio
async def test_unbounded_model_tool_loop_fails_without_returning_actions(monkeypatch):
    class LoopClient:
        def __init__(self, **kw): self.aio = self; self.models = self
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def generate_content(self, **kw):
            return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(
                role='model', parts=[types.Part.from_function_call(name='set_map_view', args={'mode': 'expanded'})]))])
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    monkeypatch.setattr(genai, 'Client', LoopClient)
    with pytest.raises(ValueError, match='Tool limit'):
        await main.ask_gemini(main.AskRequest(**REQUEST), DATA)
