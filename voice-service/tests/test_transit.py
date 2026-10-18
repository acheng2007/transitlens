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
async def test_real_sdk_structured_intent_uses_one_call_and_no_tools(monkeypatch):
    calls = []
    class FakeClient:
        def __init__(self, **kw):
            assert kw['http_options'].retry_options.attempts == 1
            self.aio = self
            self.models = self
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def generate_content(self, **kw):
            calls.append(kw)
            assert not kw['config'].tools
            assert kw['config'].response_mime_type == 'application/json'
            assert kw['config'].response_json_schema['additionalProperties'] is False
            assert kw['config'].response_schema is None
            content = types.Content(role='model', parts=[types.Part.from_text(
                text='{"scope":"allow","intent":"map_control","mode":"expanded","zoom":"in"}')])
            return types.GenerateContentResponse(candidates=[types.Candidate(finish_reason='STOP', content=content)])
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    monkeypatch.setattr(genai, 'Client', FakeClient)
    answer, actions, substantive = await main.ask_gemini(main.AskRequest(**REQUEST), DATA)
    assert answer == 'Map command ready.'
    assert not substantive
    assert [a.model_dump() for a in actions] == [dict(type='set_map_mode', mode='expanded'), dict(type='set_map_extent', extentKm=2.5)]
    assert len(calls) == 1


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
    answer = main.bus_answer({**DATA, 'status': 'stale', 'focusedBus': {**BUS, 'destination': None}}, main.Intent(scope='allow', intent='bus_info'))
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
async def test_model_tool_calls_are_rejected_without_entering_a_loop(monkeypatch):
    class LoopClient:
        def __init__(self, **kw): self.aio = self; self.models = self
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def generate_content(self, **kw):
            return types.GenerateContentResponse(candidates=[types.Candidate(finish_reason='STOP', content=types.Content(
                role='model', parts=[types.Part.from_function_call(name='set_map_view', args={'mode': 'expanded'})]))])
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    monkeypatch.setattr(genai, 'Client', LoopClient)
    with pytest.raises(ValueError):
        await main.ask_gemini(main.AskRequest(**REQUEST), DATA)


@pytest.mark.asyncio
async def test_journey_tools_resolve_option_ids_against_server_results(monkeypatch):
    from journeys import Copilot
    points=[dict(lat=29.6465,lon=-82.3478),dict(lat=29.64,lon=-82.34)]
    stops=[dict(id='a',name='Boarding',sequence=0,**points[0]),dict(id='b',name='Shands',sequence=1,**points[1])]
    overlay=dict(id='38:585',routeId='38',patternId='585',name='Route 38',color='#aabbcc',direction='OUTBOUND',shape=points,stops=stops)
    option=dict(id='option-1',routeId='38',routeName='Route 38',color='#aabbcc',patternId='585',direction='OUTBOUND',boardingStop=stops[0],alightingStop=stops[1],walkKm=0.1,rideStops=1,overlay=overlay,activeVehicles=1,prediction=None)
    plan=dict(query='Shands',demo=False,networkStatus='available',fetchedAt=DATA['fetchedAt'],status='available',scope='Direct routes only',options=[option],destinations=[stops[1]])
    copilot=Copilot(main.Context(position=main.Position(lat=29.6465,lon=-82.3478),destinationQuery='Shands'),'http://test')
    monkeypatch.setattr(copilot,'get',AsyncMock(return_value=plan))
    summary,actions=await copilot.call('find_routes',{'destination':'Shands'})
    assert 'overlay' not in summary['options'][0]
    assert actions[0].plan.options[0].boardingStop.id=='a'
    with pytest.raises(ValueError,match='no longer available'):
        await copilot.call('guide_to_stop',{'optionId':'model-invented'})
    result,actions=await copilot.call('guide_to_stop',{'optionId':'option-1'})
    assert actions[0].journey.boardingStop.id=='a'
    assert 'Approximate' in result['guidance']


@pytest.mark.asyncio
@pytest.mark.parametrize('selected_id', ['option-2', 'expired-option'])
async def test_trip_card_command_resolves_selected_journey_without_replacing_destination(monkeypatch, selected_id):
    from journeys import Copilot
    points = [dict(lat=29.6465, lon=-82.3478), dict(lat=29.64, lon=-82.34)]
    stops = [dict(id='a', name='Boarding', sequence=0, **points[0]),
             dict(id='b', name='Shands', sequence=1, **points[1])]
    overlay = dict(id='38:585', routeId='38', patternId='585', name='Route 38',
                   color='#aabbcc', direction='OUTBOUND', shape=points, stops=stops)
    option = dict(routeId='38', routeName='Route 38', color='#aabbcc', patternId='585',
                  direction='OUTBOUND', boardingStop=stops[0], alightingStop=stops[1],
                  walkKm=0.1, rideStops=1, overlay=overlay, activeVehicles=1, prediction=None)
    plan = dict(query='Shands', demo=True, networkStatus='available', fetchedAt=DATA['fetchedAt'],
                status='available', scope='Direct routes only', destinations=[stops[1]],
                options=[dict(id='option-1', **option), dict(id='option-2', **option)])
    copilot = Copilot(main.Context(dataMode='demo', destinationQuery='Shands',
                                  selectedJourneyId=selected_id,
                                  position=main.Position(lat=29.6465, lon=-82.3478)), 'http://test')
    get = AsyncMock(return_value=plan)
    monkeypatch.setattr(copilot, 'get', get)
    if selected_id == 'expired-option':
        with pytest.raises(ValueError, match='no longer available'):
            await copilot.scripted('Guide me to the selected boarding stop', None)
    else:
        _, actions = await copilot.scripted('Guide me to the selected boarding stop', None)
        assert len(actions) == 1
        assert actions[0].type == 'start_guidance'
        assert actions[0].journey.id == selected_id
        assert actions[0].journey.boardingStop.id == 'a'
    get.assert_awaited_once_with('/api/buses/plan', destination='Shands', lat=29.6465, lon=-82.3478)


def test_camera_still_is_optional_bounded_and_not_accepted_as_arbitrary_data():
    import base64
    from pydantic import ValidationError
    main.CameraImage(data=base64.b64encode(b'\xff\xd8test\xff\xd9').decode())
    for bad in ['not-base64',base64.b64encode(b'html instead').decode(),'a'*400001]:
        with pytest.raises(ValidationError): main.CameraImage(data=bad)


def test_no_key_demo_map_actions_are_labeled_not_gemini(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY',raising=False)
    monkeypatch.setattr(main,'transit_context',AsyncMock(return_value=DATA))
    request={**REQUEST,'question':'Expand the map','context':{**REQUEST['context'],'dataMode':'demo'}}
    result=TestClient(main.app).post('/api/voice/ask',json=request).json()
    assert result['source']=='local'
    assert result['demo'] is True
    assert result['actions']==[dict(type='set_map_mode',mode='expanded')]


@pytest.mark.parametrize('failure, expected', [
    (main.TransitQueryError('That route is not present in the available RTS patterns.'), 'That route is not present'),
    (httpx.ConnectError('private upstream details'), 'Transit route data is unavailable'),
    (ValueError('private validation details'), 'Transit route data is unavailable'),
])
def test_local_transit_errors_are_reported_without_unrelated_focus_advice_or_private_details(monkeypatch, failure, expected):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.setattr(main, 'transit_context', AsyncMock(return_value=DATA))
    monkeypatch.setattr(main.Copilot, 'get', AsyncMock(side_effect=failure))
    result = TestClient(main.app).post('/api/voice/ask', json={**REQUEST, 'question': 'Highlight route 99999'}).json()
    assert result['source'] == 'local'
    assert expected in result['answer']
    assert 'private' not in result['answer']
    assert 'gaze' not in result['answer']
    assert result['actions'] == []


@pytest.mark.asyncio
async def test_explicit_camera_still_reaches_gemini_without_entering_text_history(monkeypatch):
    import base64
    image_bytes=b'\xff\xd8test\xff\xd9'
    rounds=[]
    class VisionClient:
        def __init__(self,**kw): self.aio=self;self.models=self
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def generate_content(self,**kw):
            rounds.append(kw)
            assert kw['contents'][0].parts[-1].inline_data.data==image_bytes
            assert kw['contents'][0].parts[-1].inline_data.mime_type=='image/jpeg'
            content=types.Content(role='model',parts=[types.Part.from_text(
                text='{"scope":"allow","intent":"read_sign","answer":"The sign appears to show route 38."}')])
            return types.GenerateContentResponse(candidates=[types.Candidate(finish_reason='STOP', content=content)])
    monkeypatch.setenv('GEMINI_API_KEY','test-placeholder')
    monkeypatch.setattr(genai,'Client',VisionClient)
    req=main.AskRequest(**{**REQUEST,'question':'Read the bus sign','image':{'data':base64.b64encode(image_bytes).decode()}})
    answer,actions,substantive=await main.ask_gemini(req,DATA)
    assert '38' in answer
    assert not actions
    assert not req.history

    assert substantive
    assert len(rounds) == 1
