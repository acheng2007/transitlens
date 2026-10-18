"""Cheap prefilter and bounded process-local request admission."""
from __future__ import annotations

import re
import threading
import time
from collections import deque
from contextlib import contextmanager

from fastapi import HTTPException

REFUSAL = 'I can help with public transit, bus routes, stops, arrivals, and the TransitLens map. What transit help do you need?'
SCOPE_UNAVAILABLE = 'I could not check that request right now. Please try a short question about buses, routes, stops, or the map.'

# This cheap filter also protects the deterministic fallback when Gemini is absent.
# It is intentionally conservative; the model performs semantic checking when present.
FORBIDDEN = re.compile(
    r'\b(python|javascript|typescript|coding|programming|code|algorithm|sql|html|'
    r'homework|essay|poem|joke|politics|president|recipe|system prompt|api key|'
    r'password|secret|ignore.{0,30}(?:rules|instructions)|pretend|roleplay)\b', re.I)


class RequestBudget:
    """One worker: at most 60 requests/minute and 3 active requests, no queue."""
    def __init__(self, per_minute=60, concurrent=3):
        self.per_minute = per_minute
        self.concurrent = concurrent
        self.starts = deque()
        self.active = 0
        self.lock = threading.Lock()

    @contextmanager
    def admit(self):
        with self.lock:
            now = time.monotonic()
            while self.starts and self.starts[0] <= now - 60:
                self.starts.popleft()
            if len(self.starts) >= self.per_minute or self.active >= self.concurrent:
                raise HTTPException(429, 'Transit assistant is busy. Please try again shortly.',
                                    headers={'Retry-After': '60'})
            self.starts.append(now)
            self.active += 1
        try:
            yield
        finally:
            with self.lock:
                self.active -= 1
