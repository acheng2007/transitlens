"""Bounded immutable clarification capabilities, independent of chat text and audio."""
from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import re
import secrets
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Expected = Literal['route', 'stop', 'destination', 'vehicle', 'choice']
FROZEN_REFERENCES = ('focusedBusId', 'previousBusId', 'selectedRouteId', 'selectedBusId',
                     'selectedStopId', 'busStopQuery', 'selectedJourneyId', 'destinationQuery', 'onboardBusId')


class Clarification(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    id: str = Field(pattern=r'^[A-Za-z0-9_-]{43}$')
    prompt: str = Field(min_length=1, max_length=2000)
    expected: Expected
    expiresAt: str


@dataclass(frozen=True)
class Candidate:
    id: str
    label: str
    field: Literal['stopQuery', 'vehicleId', 'optionId', 'destination']


def prompt_for(expected):
    return {
        'route': 'Which route or vehicle should I check?',
        'stop': 'Which stop do you mean? Say its name or stop ID.',
        'destination': 'Where would you like to go?',
        'vehicle': 'Which vehicle do you mean? Say its vehicle ID.',
        'choice': 'Which displayed option do you mean?',
    }[expected]


class NeedClarification(Exception):
    def __init__(self, prompt, intent, expected, candidates=(), actions=(), context=None):
        super().__init__(prompt)
        self.prompt = prompt
        self.draft = intent.model_dump(exclude={'clarification'}, exclude_none=True) if hasattr(intent, 'model_dump') else deepcopy(intent)
        self.expected = expected
        self.candidates = tuple(candidates)
        self.actions = list(actions)
        self.context = context or {}


@dataclass(frozen=True)
class Pending:
    public: Clarification
    session: str
    mode: str
    question: str
    draft: dict
    references: dict
    candidates: tuple[Candidate, ...]
    deadline: float


class ClarificationStore:
    def __init__(self, limit=128, ttl=300, clock=time.monotonic, wall_clock=time.time):
        self.limit, self.ttl, self.clock, self.wall_clock = limit, ttl, clock, wall_clock
        self.entries = OrderedDict()

    def issue(self, req, needed):
        if not req.context.sessionId:
            return None  # Older clients retain their stateless interface.
        now = self.clock()
        for key, record in list(self.entries.items()):
            if record.deadline <= now:
                del self.entries[key]
        token = secrets.token_urlsafe(32)
        public = Clarification(id=token, prompt=needed.prompt, expected=needed.expected,
            expiresAt=datetime.fromtimestamp(self.wall_clock() + self.ttl, timezone.utc).isoformat())
        refs = {key: getattr(req.context, key) for key in FROZEN_REFERENCES}
        refs.update(needed.context)
        self.entries[token] = Pending(public, req.context.sessionId, req.context.dataMode,
            req.question, deepcopy(needed.draft), deepcopy(refs), needed.candidates, now + self.ttl)
        while len(self.entries) > self.limit:
            self.entries.popitem(last=False)
        return public

    def get(self, token, context):
        record = self.entries.get(token)
        if not record or record.deadline <= self.clock() or record.session != context.sessionId or record.mode != context.dataMode:
            return None
        return deepcopy(record)


def simple_reply(record, text):
    """Return a slot update, or None when semantic interpretation is required."""
    q = re.sub(r'\s+', ' ', text.lower().strip()).rstrip('.!?')
    if record.candidates:
        ordinal = re.fullmatch(r'(?:the |option |number )?(first|second|third|fourth|fifth|sixth|[1-6])(?: one| option| stop| bus| vehicle)?', q)
        if ordinal:
            words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']
            index = words.index(ordinal[1]) if ordinal[1] in words else int(ordinal[1]) - 1
            return candidate_update(record, record.candidates[index]) if index < len(record.candidates) else {}
        matches = [c for c in record.candidates if q in (c.id.lower(), c.label.lower(), f'stop {c.id}'.lower(), f'vehicle {c.id}'.lower())]
        return candidate_update(record, matches[0]) if len(matches) == 1 else None
    if record.public.expected == 'route':
        m = re.fullmatch(r'(?:route |bus )?([0-9]{1,5}[a-z]?)', q)
        if m:
            return {'routeId': m[1]}
        m = re.fullmatch(r'vehicle ([a-z0-9_-]{1,100})', q)
        return {'vehicleId': m[1]} if m else None
    if record.public.expected == 'vehicle':
        m = re.fullmatch(r'(?:(?:vehicle |bus )([a-z0-9_-]{1,100})|([0-9]{1,12}|demo-[0-9]+))', q)
        return {'vehicleId': m[1] or m[2]} if m else None
    if record.public.expected in ('stop', 'destination'):
        # A bounded label, not a partial match inside another request.
        if re.fullmatch(r"[\w @./'-]{1,120}", q) and len(q.split()) <= 8 and not re.match(r'^(show|tell|what|when|where|how|take|get|highlight|cancel|close|open|zoom|please|i|expand|enlarge|make|could|can|would|will|let|find|guide|is|are|do|does|why|which)\b', q):
            value = re.sub(r'^stop ', '', text.strip(), flags=re.I)
            return {'stopQuery' if record.public.expected == 'stop' else 'destination': value}
    return None


def candidate_update(record, candidate):
    return {candidate.field: candidate.id}


def resume(record, updates):
    draft = deepcopy(record.draft)
    draft.update(updates)
    if 'vehicleId' in updates:
        draft.pop('routeId', None)
    if 'routeId' in updates:
        draft.pop('vehicleId', None)
    if 'optionId' in updates:
        draft.pop('destination', None)
    if 'optionId' in updates or 'stopQuery' in updates:
        draft.pop('choice', None)
    return draft
