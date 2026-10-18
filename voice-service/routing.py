"""Grounded routing responses. The model supplies references, never transit facts."""
from clarifications import NeedClarification, Candidate
from journeys import (BusChoice, BusStopResult, Overlay, ShowBusStop, ShowBusChoices,
                      SetOnboardBus, ShowRoutes, TransitQueryError)


def selected_bus(context, intent):
    if intent.vehicleId:
        return intent.vehicleId
    if intent.routeId:
        return None
    return {'focused': context.focusedBusId, 'previous': context.previousBusId,
            'selected': context.selectedBusId, 'onboard': context.onboardBusId,
            'nearby': None}.get(intent.busTarget)


def bus_choice(row):
    return BusChoice(id=row['id'], routeId=row['route'], patternId=row.get('patternId'),
                     destination=row.get('destination'), lat=row['lat'], lon=row['lon'])


def observation_answer(row, fresh):
    text = f'Vehicle {row.busId}, route {row.routeId}: {row.distanceKm / 1.609344:.2f} miles straight-line from the stop.'
    if not fresh:
        return text + ' This is last reported data; current approach and arrival are unknown.'
    if row.progress == 'passed':
        text += ' It has passed this stop on its current pattern.'
    elif row.progress == 'not_served':
        text += ' Its current pattern does not serve this stop.'
    elif row.alongRouteKm is not None and row.progress == 'approaching':
        text += f' Approximately {row.alongRouteKm / 1.609344:.2f} miles remain along its route.'
    else:
        text += ' Its progress along the route cannot be confirmed.'
    prediction = row.prediction
    if prediction and prediction.minutes is not None and prediction.status in ('available', 'demo'):
        text += f" {'Scripted demo arrival' if prediction.status == 'demo' else 'RTS predicts'} {prediction.minutes:.0f} minutes."
    return text


async def resolve_routing(req, intent, copilot):
    context = req.context
    if intent.intent == 'leave_bus':
        return 'Onboard selection cleared.', [SetOnboardBus(bus=None)], False, None
    bus_id = selected_bus(context, intent)
    route_id = intent.routeId or (context.selectedRouteId if not bus_id else None)
    if intent.intent == 'bus_stop_distance':
        query = intent.stopQuery or context.selectedStopId or context.busStopQuery
        if not query:
            raise NeedClarification('Which stop do you mean? Say its name or stop ID.', intent, 'stop')
        if not bus_id and not route_id:
            raise NeedClarification('Which route or vehicle should I check at that stop?', intent, 'route')
        params = dict(stop=query)
        if bus_id:
            params['busId'] = bus_id
        if route_id:
            params['routeId'] = route_id
        result = BusStopResult.model_validate(await copilot.get('/api/buses/stop-distance', **params))
        if result.status == 'ambiguous' and intent.choice:
            if intent.choice > len(result.stops):
                raise NeedClarification('That stop option is unavailable. Choose one of the displayed stops.', intent, 'choice', [Candidate(s.id, s.name, 'stopQuery') for s in result.stops[:6]], [ShowBusStop(result=result)])
            params['stop'] = result.stops[intent.choice - 1].id
            result = BusStopResult.model_validate(await copilot.get('/api/buses/stop-distance', **params))
        actions = [ShowBusStop(result=result)]
        if result.status == 'ambiguous':
            raise NeedClarification('Which stop do you mean? ' + '; '.join(f'{i + 1}: {s.name}, stop {s.id}' for i, s in enumerate(result.stops[:6])), intent, 'choice', [Candidate(s.id, s.name, 'stopQuery') for s in result.stops[:6]], actions)
        if result.status == 'not_found':
            raise NeedClarification('I could not find that stop. Say its name or stop ID.', intent, 'stop', actions=actions)
        if result.status == 'unavailable':
            raise TransitQueryError('Stop data is unavailable right now.')
        if result.status != 'available' or not result.stop:
            return ('Stop data is unavailable right now.' if result.status == 'unavailable' else 'I could not find that stop in the available RTS catalog. Try its stop ID.'), actions, False, None
        if result.vehicleStatus == 'unavailable':
            raise TransitQueryError(f'{result.stop.name} is selected, but live vehicle data is unavailable. Current bus positions and arrivals are unknown.')
        if not result.vehicles:
            return f'No matching vehicles were reported for {result.stop.name}. This does not establish that service is canceled.', actions, False, None
        fresh = result.vehicleStatus == 'available'
        answer = ('Scripted demo data. ' if result.demo else '') + f'At {result.stop.name} (stop {result.stop.id}). '
        answer += ' '.join(observation_answer(v, fresh) for v in result.vehicles[:3])
        if not any(v.prediction and v.prediction.minutes is not None for v in result.vehicles[:3]):
            answer += ' No verified arrival prediction is available for these vehicles.'
        if len(result.vehicles) > 3:
            answer += f' Showing {len(result.vehicles)} matching vehicles on the map.'
        if result.networkStatus != 'available':
            answer += f' The route catalog is {result.networkStatus}.'
        return answer, actions, fresh, None
    if not bus_id and not route_id:
        raise NeedClarification('Which route or vehicle do you mean?', intent, 'route')
    params = {key: value for key, value in {'busId': bus_id, 'routeId': route_id}.items() if value}
    details = await copilot.get('/api/buses/route-details', **params)
    routes = [Overlay.model_validate(p) for p in details.get('routes', [])]
    if details.get('status') == 'not_found':
        raise NeedClarification('That route or vehicle is not available. Which one do you mean?', intent, 'route')
    if details.get('status') == 'unavailable':
        raise TransitQueryError('Route data is unavailable right now.')
    if details.get('status') != 'available' or not routes:
        return 'That bus or route is not available in the current RTS data.', [], False, None
    buses = [bus_choice(v) for v in details['buses']]
    if intent.intent == 'board_bus':
        if details.get('vehicleStatus') != 'available':
            raise TransitQueryError('Current vehicle data is unavailable. I cannot confirm an onboard vehicle yet.')
        if len(buses) > 1:
            choices = buses[:6]
            prompt = 'Which vehicle are you on? ' + '; '.join(f'{i + 1}: vehicle {b.id}, {b.destination or "destination unknown"}' for i, b in enumerate(choices))
            raise NeedClarification(prompt, intent, 'vehicle', [Candidate(b.id, f'vehicle {b.id}', 'vehicleId') for b in choices], [ShowBusChoices(buses=choices)])
        if len(buses) != 1:
            return ('Several vehicles match that route. Which vehicle are you on?' if buses else 'No vehicle was reported on that route.'), [ShowBusChoices(buses=buses)] if buses else [], False, None
        bus = buses[0]
        prompt = f'You selected vehicle {bus.id} on route {bus.routeId} as your onboard bus. Where would you like to get off?'
        raise NeedClarification(prompt, dict(scope='allow', intent='boarding_guidance'), 'destination',
            actions=[SetOnboardBus(bus=bus)], context={'onboardBusId': bus.id, 'selectedBusId': bus.id, 'selectedRouteId': bus.routeId})
    names = ', '.join(s['name'] for s in details.get('nextStops', [])[:4])
    first = routes[0]
    answer = ('Scripted demo data. ' if context.dataMode == 'demo' else '') + f'Route {first.routeId}: {first.name}. '
    if names:
        answer += f'Next stops on the reported pattern: {names}.'
    else:
        answer += ' '.join(f'{p.direction}: {p.stops[0].name} to {p.stops[-1].name}, {len(p.stops)} stops.' for p in routes[:2])
        answer += ' These are route endpoints, not confirmation of the next stop.'
    if details.get('networkStatus') != 'available':
        answer += f" The route catalog is {details.get('networkStatus')}."
    # An informational follow-up must not cancel an existing trip, stop query, or onboard selection.
    actions = [] if context.destinationQuery or context.busStopQuery or context.onboardBusId else [ShowRoutes(routes=routes)]
    return answer, actions, True, None
