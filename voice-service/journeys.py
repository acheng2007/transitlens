"""Validated transit tools and action payloads. Geometry only comes from bus-service."""
import re
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Point(Model):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class Stop(Point):
    id: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=200)
    sequence: int = Field(ge=0)


class Overlay(Model):
    id: str = Field(min_length=1, max_length=120)
    patternId: str = Field(min_length=1, max_length=100)
    routeId: str = Field(min_length=1, max_length=30)
    name: str = Field(min_length=1, max_length=200)
    color: str = Field(pattern=r'^#[0-9a-fA-F]{6}$')
    direction: str = Field(min_length=1, max_length=100)
    shape: list[Point] = Field(min_length=2, max_length=3000)
    stops: list[Stop] = Field(min_length=1, max_length=300)


class Arrival(Model):
    status: Literal['available', 'unavailable', 'demo']
    minutes: float | None = Field(default=None, ge=0, le=1440)
    vehicleId: str | None = None
    fetchedAt: str | None = None
    label: str


class Journey(Model):
    id: str = Field(min_length=1, max_length=300)
    routeId: str
    routeName: str
    color: str
    patternId: str
    direction: str
    boardingStop: Stop
    alightingStop: Stop
    walkKm: float = Field(ge=0, le=0.8)
    rideStops: int = Field(ge=1)
    overlay: Overlay
    activeVehicles: int = Field(ge=0)
    prediction: Arrival | None = None


class Plan(Model):
    query: str = Field(min_length=1, max_length=120)
    demo: bool
    networkStatus: Literal['available', 'partial', 'stale', 'unavailable']
    fetchedAt: str | None
    status: Literal['available', 'not_found', 'unavailable', 'ambiguous', 'no_direct_routes']
    scope: str
    options: list[Journey] = Field(max_length=6)
    destinations: list[Stop] = Field(max_length=8)


class ShowJourneys(Model):
    type: Literal['show_journeys'] = 'show_journeys'
    plan: Plan


class ShowRoutes(Model):
    type: Literal['show_routes'] = 'show_routes'
    routes: list[Overlay] = Field(min_length=1, max_length=6)


class StartGuidance(Model):
    type: Literal['start_guidance'] = 'start_guidance'
    journey: Journey


class ClearGuidance(Model):
    type: Literal['clear_guidance'] = 'clear_guidance'


def tool(name, description, properties):
    return dict(name=name, description=description, parameters=dict(type='OBJECT', properties=properties,
                required=list(properties)))


JOURNEY_TOOLS = [
    tool('find_routes', 'Find direct route options to a place using actual stop names and ordered patterns. Show route choices and geometry on the map. Clarify ambiguous destinations.',
         {'destination': {'type': 'STRING', 'description': 'Named destination or an exact stop ID returned by this tool.'}}),
    tool('highlight_route', 'Highlight verified patterns and stops for an actual route number.', {'routeId': {'type': 'STRING'}}),
    tool('guide_to_stop', 'Select a returned journey option and begin approximate bearing/distance guidance to its stationary boarding stop, not a walking path.', {'optionId': {'type': 'STRING'}}),
    tool('cancel_guidance', 'Clear the trip selection and return to normal exploration.', {}),
]


class Copilot:
    def __init__(self, context, base_url):
        self.context = context
        self.base_url = base_url
        self.plan = None

    async def get(self, path, **params):
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(self.base_url + path, params={**params, 'demo': self.context.dataMode == 'demo'})
        response.raise_for_status()
        return response.json()

    async def find(self, query):
        if self.context.position is None:
            raise ValueError('Waiting for location. No trip was planned.')
        data = await self.get('/api/buses/plan', destination=query,
                              **self.context.position.model_dump())
        self.plan = Plan.model_validate(data)
        return self.plan

    async def call(self, name, args):
        if name == 'find_routes':
            query = args.get('destination')
            if set(args) != {'destination'} or not isinstance(query, str) or not 1 <= len(query.strip()) <= 120:
                raise ValueError('Supply a destination name or returned stop ID.')
            plan = await self.find(query.strip())
            # Gemini gets useful facts, not hundreds of route coordinates.
            summary = plan.model_dump(exclude={'options': {'__all__': {'overlay'}}, 'destinations': {'__all__': {'sequence'}}})
            return summary, [ShowJourneys(plan=plan)]
        if name == 'highlight_route':
            if set(args) != {'routeId'} or not isinstance(args['routeId'], str):
                raise ValueError('Supply a route ID.')
            network = await self.get('/api/buses/network')
            routes = [Overlay.model_validate(p) for p in network['patterns'] if p['routeId'] == args['routeId']][:6]
            if not routes:
                raise ValueError('That route is not present in the available RTS patterns.')
            return {'routeId': args['routeId'], 'patterns': [p.id for p in routes], 'status': network['status']}, [ShowRoutes(routes=routes)]
        if name == 'guide_to_stop':
            if set(args) != {'optionId'} or not isinstance(args['optionId'], str):
                raise ValueError('Use an option ID returned by find_routes.')
            if not self.plan and self.context.destinationQuery:
                await self.find(self.context.destinationQuery)
            option = next((o for o in self.plan.options if o.id == args['optionId']), None) if self.plan else None
            if not option:
                raise ValueError('This option is no longer available. Search the destination again.')
            return {'boardingStop': option.boardingStop.name, 'route': option.routeId,
                    'direction': option.direction, 'guidance': 'Approximate bearing only. No verified pedestrian path.'}, [StartGuidance(journey=option)]
        if name == 'cancel_guidance' and not args:
            return {'prepared': 'clear_guidance'}, [ClearGuidance()]
        raise ValueError('Unsupported transit tool')

    async def scripted(self, question, focused_bus):
        """Explicit demo/local commands, separate from Gemini. No invented live facts."""
        q = question.strip().lower().rstrip('?.!')
        if re.search(r'cancel|clear.*(?:trip|guidance)|stop.*guidance', q):
            return 'Guidance cleared.', [ClearGuidance()]
        route = re.search(r'(?:highlight|show|select)\s+(?:me\s+)?route\s+(\w+)', q)
        if route:
            _, actions = await self.call('highlight_route', {'routeId': route[1]})
            return f'Route {route[1]} is ready.', actions
        query = re.search(r'(?:routes? to|(?:get|take|guide) me to|go to|goes to|going to)\s+(.+)', q)
        if query:
            plan = await self.find(query[1])
            actions = [ShowJourneys(plan=plan)]
            if re.search(r'(?:get|take|guide) me to', q) and plan.options:
                actions.append(StartGuidance(journey=plan.options[0]))
            if focused_bus and re.search(r'(?:does|will|can).*bus', q):
                matches = [o for o in plan.options if o.routeId == focused_bus['route']]
                verified = any(o.patternId == focused_bus.get('patternId') for o in matches)
                return ('The selected bus pattern serves a matching stop downstream.' if verified else
                        'I cannot confirm that vehicle serves the destination. Here are the verified direct-route options.'), actions
            return f'Found {len(plan.options)} direct options.' if plan.options else 'Please choose a more specific stop.' if plan.status == 'ambiguous' else 'No direct trip found within the current boarding-distance limit.', actions
        choice = re.search(r'use journey (.+)', question, re.I)
        index = re.search(r'\b(first|second|third|best)\b', q)
        if choice or index or re.search(r'guide.*(?:stop|there)|take.*(?:one|route)', q):
            if not self.context.destinationQuery:
                raise ValueError('Choose a destination first, for example get me to Shands.')
            plan = await self.find(self.context.destinationQuery)
            position = {'first': 0, 'best': 0, 'second': 1, 'third': 2}.get(index[1], 0) if index else 0
            selected = choice[1] if choice else self.context.selectedJourneyId or (plan.options[position].id if len(plan.options) > position else '')
            result, actions = await self.call('guide_to_stop', {'optionId': selected})
            return f"Board at {result['boardingStop']}.", actions
        return None
