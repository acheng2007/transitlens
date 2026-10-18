"""Independent process-local provider budgets. Never log request content."""
from collections import Counter, deque
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import logging
import math
import os
import threading
import time

log = logging.getLogger('transit-voice.usage')
log.setLevel(logging.INFO)
if not log.handlers:
    log.addHandler(logging.StreamHandler())
metrics = Counter()


def record(event):
    metrics[event] += 1
    log.info('voice_event=%s count=%d', event, metrics[event])


class ProviderUnavailable(RuntimeError):
    def __init__(self, message='Provider temporarily unavailable', retry_after=60):
        super().__init__(message)
        self.retry_after = retry_after


class ProviderBudget:
    def __init__(self, name, per_minute):
        self.name = name
        self.per_minute = per_minute
        self.starts = deque()
        self.cooldown_until = 0
        self.lock = threading.Lock()

    def take(self):
        with self.lock:
            now = time.monotonic()
            while self.starts and self.starts[0] <= now - 60:
                self.starts.popleft()
            if now < self.cooldown_until or len(self.starts) >= self.per_minute:
                record(self.name + '_budget_or_cooldown')
                raise ProviderUnavailable(retry_after=self.retry_after(now))
            self.starts.append(now)
            record(self.name + '_provider_call')

    def retry_after(self, now=None):
        now = time.monotonic() if now is None else now
        delay = max(0, self.cooldown_until - now)
        if len(self.starts) >= self.per_minute:
            delay = max(delay, self.starts[0] + 60 - now)
        return max(1, math.ceil(delay))

    def cooldown(self, retry_after=None):
        seconds = 60.0
        if retry_after is not None:
            try:
                seconds = max(0, float(retry_after))
            except (ValueError, TypeError):
                try:
                    date = parsedate_to_datetime(str(retry_after))
                    seconds = max(0, (date - datetime.now(timezone.utc)).total_seconds())
                except (ValueError, TypeError, OverflowError):
                    pass
        if not math.isfinite(seconds):
            seconds = 60.0
        with self.lock:
            self.cooldown_until = max(self.cooldown_until, time.monotonic() + seconds)
        record(self.name + '_cooldown')

    def on_error(self, error):
        response = getattr(error, 'response', None)
        response = getattr(response, '_response', response)
        code = getattr(error, 'code', None) or getattr(response, 'status_code', None) or getattr(response, 'status', None)
        if code == 429:
            headers = getattr(response, 'headers', {}) or {}
            self.cooldown(headers.get('Retry-After'))


text_budget = ProviderBudget('text', 12)
def configured_tts_limit():
    try:
        value = int(os.getenv('GEMINI_TTS_GENERATIONS_PER_MINUTE', '10'))
        return value if 1 <= value <= 120 else 10
    except ValueError:
        return 10


tts_budget = ProviderBudget('tts', configured_tts_limit())
