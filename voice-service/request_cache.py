"""Bounded, session-scoped idempotency for retried assistant requests."""
import asyncio
import hashlib
import time
from collections import OrderedDict

from fastapi import HTTPException


class RequestCache:
    def __init__(self, limit=128, ttl=60):
        self.entries = OrderedDict()
        self.limit = limit
        self.ttl = ttl

    async def run(self, request, operation):
        if not request.context.sessionId:
            return await operation()
        now = time.monotonic()
        for key, (_, created, task) in list(self.entries.items()):
            if task.done() and now - created > self.ttl:
                self.entries.pop(key)
        key = (request.context.sessionId, request.requestId)
        digest = hashlib.sha256(request.model_dump_json().encode()).digest()
        if key in self.entries:
            previous, _, task = self.entries[key]
            if previous != digest:
                raise HTTPException(409, 'This request ID was already used for a different question.')
            return await asyncio.shield(task)
        if len(self.entries) >= self.limit:
            removable = next((k for k, (_, _, task) in self.entries.items() if task.done()), None)
            if removable is None:
                raise HTTPException(429, 'Transit assistant is busy. Please try again shortly.')
            self.entries.pop(removable)
        task = asyncio.create_task(operation())
        self.entries[key] = (digest, now, task)
        # Consume exceptions even if the original HTTP caller disconnects.
        task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
        return await asyncio.shield(task)
