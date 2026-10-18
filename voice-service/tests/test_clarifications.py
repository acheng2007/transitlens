"""Multi-turn requests against the captured bus API, without cloud calls."""
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

import main
from clarifications import ClarificationStore, NeedClarification
from intents import Intent, ClarificationProposal
from provider_usage import ProviderUnavailable
from test_routing import grounded_api


def req(question, token=None, **context):
    return main.AskRequest(requestId=str(uuid4()), question=question, context={
        'sessionId': 'clarification-session', 'dataMode': 'demo',
        'position': {'lat': 29.6465, 'lon': -82.3478}, 'clarificationId': token, **context})


@pytest.mark.asyncio
async def test_route_and_stop_answers_complete_goal_across_map_commands(grounded_api):
    initial = await main.ask(req('When does the bus arrive?'))
    assert initial.clarification.expected == 'stop'
    stop = await main.ask(req('Shands', initial.clarification.id))
    assert stop.clarification.expected == 'route'
    token = stop.clarification.id
    for command in ['zoom out', 'close the map']:
        interlude = await main.ask(req(command, token))
        assert interlude.actions and interlude.clarification.id == token
    result = await main.ask(req('38', token, focusedBusId='unrelated-gaze'))
    assert result.clarification is None
    action = result.actions[0]
    assert action.type == 'show_bus_stop' and action.result.routeId == '38'
    assert action.result.stop.id == '0018'
    assert 'arrival' in result.answer.lower()


@pytest.mark.asyncio
async def test_stop_choice_uses_id_after_candidate_order_changes(grounded_api):
    catalog, rows = grounded_api
    stops = catalog['patterns'][0]['stops']
    stops[1]['id'], stops[2]['id'] = 'test-east', 'test-west'
    stops[1]['name'], stops[2]['name'] = 'Test Stop East', 'Test Stop West'
    first = await main.ask(req('How far is route 9 from Test Stop'))
    assert first.clarification.expected == 'choice'
    chosen = first.actions[0].result.stops[1].id
    stops[1], stops[2] = stops[2], stops[1]
    answer = await main.ask(req('second stop', first.clarification.id))
    assert answer.actions[0].result.stop.id == chosen
    assert answer.clarification is None


@pytest.mark.asyncio
async def test_vehicle_then_destination_preserves_onboard_selection(grounded_api):
    first = await main.ask(req('I am on route 9'))
    assert first.clarification.expected == 'vehicle'
    bus_id = first.actions[0].buses[1].id
    invalid = await main.ask(req('sixth', first.clarification.id))
    assert invalid.clarification.id == first.clarification.id and not invalid.actions
    selected = await main.ask(req('the second bus', first.clarification.id))
    assert selected.actions[0].bus.id == bus_id
    assert selected.clarification.expected == 'destination'
    record = main.clarification_store.get(selected.clarification.id, req('x').context)
    assert record.references['onboardBusId'] == bus_id
    final = await main.ask(req('Reitz Union', selected.clarification.id))
    assert final.clarification is None
    assert all(a.type != 'set_onboard_bus' for a in final.actions)


@pytest.mark.asyncio
async def test_invalid_slot_and_provider_failure_retain_goal(grounded_api, monkeypatch):
    first = await main.ask(req('How far is route 38 from that stop'))
    invalid = await main.ask(req('missing-stop-xyz', first.clarification.id))
    assert invalid.clarification.expected == 'stop'
    record = main.clarification_store.get(invalid.clarification.id, req('x').context)
    assert record.draft['routeId'] == '38'
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    monkeypatch.setattr(main, 'interpret_followup', AsyncMock(side_effect=ProviderUnavailable()))
    failed = await main.ask(req('the one that is over on the other side of campus', invalid.clarification.id))
    assert failed.clarification.id == invalid.clarification.id and not failed.actions


@pytest.mark.asyncio
async def test_cancel_new_topic_and_missing_or_mismatched_token(grounded_api):
    first = await main.ask(req('When does the bus arrive?'))
    token = first.clarification.id
    for command in ['never mind', 'cancel that question', 'cancel guidance']:
        answer = await main.ask(req(command, token))
        assert answer.clarification is None
    other = await main.ask(req('Tell me more about this route', token, selectedRouteId='38'))
    assert other.clarification is None
    for context in [{'sessionId': 'other-session'}, {'dataMode': 'live'}]:
        answer = await main.ask(req('38', token, **context))
        assert 'repeat your full request' in answer.answer and not answer.actions
    main.clarification_store = ClarificationStore()
    answer = await main.ask(req('38', token))
    assert answer.clarification is None and not answer.actions


def test_store_expiry_capacity_and_immutable_snapshots():
    clock = [0]
    store = ClarificationStore(limit=2, ttl=300, clock=lambda: clock[0], wall_clock=lambda: 1000)
    request = req('original')
    needed = NeedClarification('Which route?', Intent(scope='allow', intent='bus_stop_distance'), 'route')
    first = store.issue(request, needed)
    snapshot = store.get(first.id, request.context)
    snapshot.draft['routeId'] = 'wrong'
    assert 'routeId' not in store.get(first.id, request.context).draft
    second = store.issue(request, needed)
    third = store.issue(request, needed)
    assert store.get(first.id, request.context) is None and len(store.entries) == 2
    clock[0] = 301
    assert store.get(second.id, request.context) is None and store.get(third.id, request.context) is None


@pytest.mark.asyncio
async def test_retry_and_semantic_clarification(grounded_api, monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    decision = Intent(scope='clarify', intent='none', answer='Which route?',
        clarification=ClarificationProposal(resumeIntent='bus_stop_distance', expected='route', stopQuery='Shands'))
    generate = AsyncMock(return_value=decision)
    monkeypatch.setattr(main, 'generate_json', generate)
    question = req('Could you check when it comes here?')
    first = await main.ask(question)
    repeated = await main.ask(question)
    assert repeated.clarification.id == first.clarification.id
    generate.assert_awaited_once()
    result = await main.ask(req('route 38', first.clarification.id))
    assert result.actions[0].result.routeId == '38' and result.clarification is None
    generate.assert_awaited_once()


@pytest.mark.asyncio
async def test_free_form_reply_completes_only_the_pending_goal(grounded_api, monkeypatch):
    first = await main.ask(req('How far is route 38 from that stop'))
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    interpret = AsyncMock(return_value=main.FollowupDecision(action='answer', value='Shands'))
    monkeypatch.setattr(main, 'interpret_followup', interpret)
    result = await main.ask(req('I mean the hospital on campus, please', first.clarification.id))
    assert result.actions[0].result.routeId == '38' and result.actions[0].result.stop.id == '0018'
    interpret.assert_awaited_once()


@pytest.mark.asyncio
async def test_unsupported_capability_has_no_pending_input(grounded_api, monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    monkeypatch.setattr(main, 'generate_json', AsyncMock(return_value=Intent(scope='clarify', intent='none',
        answer='I do not have verified service start times.')))
    answer = await main.ask(req('When does bus service start back up?'))
    assert answer.clarification is None and not answer.actions

@pytest.mark.asyncio
async def test_onboard_travel_keeps_destination_while_identifying_route_and_vehicle(grounded_api):
    first = await main.ask(req('How can I get to Reitz Union from where I am on the bus'))
    assert first.clarification.expected == 'route'
    record = main.clarification_store.get(first.clarification.id, req('x').context)
    assert record.draft['destination'].lower() == 'reitz union'
    vehicles = await main.ask(req('9', first.clarification.id))
    assert vehicles.clarification.expected == 'vehicle'
    chosen = vehicles.actions[0].buses[0].id
    complete = await main.ask(req('first', vehicles.clarification.id))
    assert any(a.type == 'set_onboard_bus' and a.bus.id == chosen for a in complete.actions)
    record = main.clarification_store.get(vehicles.clarification.id, req('x').context)
    assert record.draft['destination'].lower() == 'reitz union'  # Previous token is immutable.
    assert complete.clarification is None or complete.clarification.expected == 'choice'


@pytest.mark.asyncio
async def test_destination_ambiguity_continues_guidance_instead_of_route_search(grounded_api):
    catalog, rows = grounded_api
    stops = catalog['patterns'][0]['stops']
    stops[1]['id'], stops[2]['id'] = 'destination-east', 'destination-west'
    stops[1]['name'], stops[2]['name'] = 'Destination East', 'Destination West'
    stops[2]['lat'] += 0.02
    first = await main.ask(req('Take me to Destination'))
    assert first.clarification.expected == 'choice'
    record = main.clarification_store.get(first.clarification.id, req('x').context)
    assert record.draft['intent'] == 'boarding_guidance'
    result = await main.ask(req('second', first.clarification.id))
    if result.clarification:
        next_record = main.clarification_store.get(result.clarification.id, req('x').context)
        assert next_record.draft['intent'] == 'boarding_guidance'
    else:
        assert any(a.type == 'show_journeys' and a.plan.query == record.candidates[1].id for a in result.actions)


@pytest.mark.asyncio
async def test_transit_outage_keeps_pending_input(grounded_api, monkeypatch):
    first = await main.ask(req('How far is route 38 from that stop'))
    async def unavailable(*args, **kwargs):
        return dict(status='unavailable', stops=[], stop=None, vehicles=[], routes=[],
                    query='Shands', routeId='38', busId=None, demo=True,
                    networkStatus='unavailable', fetchedAt=None, vehicleStatus='unavailable', vehicleFetchedAt=None)
    monkeypatch.setattr(main.Copilot, 'get', unavailable)
    reply = await main.ask(req('Shands', first.clarification.id))
    assert reply.clarification.id == first.clarification.id
    assert not reply.actions and 'unavailable' in reply.answer.lower()


@pytest.mark.asyncio
async def test_free_form_map_interlude_preserves_token_and_explicit_topic_replaces_it(grounded_api, monkeypatch):
    first = await main.ask(req('How far is route 38 from that stop'))
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    interpret = AsyncMock(return_value=main.FollowupDecision(action='new_request'))
    decision = AsyncMock(return_value=Intent(scope='allow', intent='map_control', mode='expanded'))
    monkeypatch.setattr(main, 'decide_intent', decision)
    monkeypatch.setattr(main, 'interpret_followup', interpret)
    mapped = await main.ask(req('Could you make the map bigger for me?', first.clarification.id))
    assert mapped.clarification.id == first.clarification.id
    assert mapped.actions[0].type == 'set_map_mode'
    decision.return_value = Intent(scope='allow', intent='route_info', routeId='9')
    other = await main.ask(req('Can you describe route nine instead?', first.clarification.id))
    assert other.clarification is None
    assert 'Route 9' in other.answer


def test_pending_proposals_cannot_prepare_incompatible_work():
    with pytest.raises(ValueError):
        Intent(scope='clarify', intent='none', clarification=ClarificationProposal(resumeIntent='find_routes', expected='route'))
    with pytest.raises(ValueError):
        Intent(scope='allow', intent='map_control', mode='expanded', clarification=ClarificationProposal(resumeIntent='find_routes', expected='destination'))
