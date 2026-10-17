"""Tiny in-memory TTL cache."""
import time
from typing import Any


class TTLCache:
    def __init__(self, ttl_s: float):
        self.ttl_s = ttl_s
        self._data: dict[Any, tuple[float, Any]] = {}

    def get(self, key: Any) -> Any | None:
        hit = self._data.get(key)
        if hit is None:
            return None
        ts, value = hit
        if time.monotonic() - ts > self.ttl_s:
            return None
        return value

    def get_stale(self, key: Any) -> Any | None:
        """Return the value even if expired (fallback when upstream is down)."""
        hit = self._data.get(key)
        return hit[1] if hit else None

    def set(self, key: Any, value: Any) -> None:
        self._data[key] = (time.monotonic(), value)

    def __contains__(self, key: Any) -> bool:
        return self.get(key) is not None
