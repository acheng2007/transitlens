"""Lazy, approved-text-only Gemini TTS with bounded ephemeral storage."""
import asyncio
import base64
import binascii
from collections import Counter, OrderedDict
import io
import os
import secrets
import time
import wave

import httpx
from fastapi import HTTPException
from provider_usage import tts_budget, record, ProviderUnavailable

MODEL = 'gemini-3.8-flash-lite-tts'
VOICE = 'Sulafat'
STYLE = 'Warm, casual, conversational.'
MAX_AUDIO = 32 * 1024 * 1024


def valid_wav(audio):
    if not 44 <= len(audio) <= MAX_AUDIO or audio[:4] != b'RIFF' or audio[8:12] != b'WAVE':
        return False
    try:
        with wave.open(io.BytesIO(audio), 'rb') as wav:
            frames = wav.getnframes()
            return (wav.getcomptype() == 'NONE' and wav.getnchannels() in (1, 2)
                    and wav.getsampwidth() in (1, 2, 3, 4) and 8000 <= wav.getframerate() <= 96000
                    and 0 < frames <= wav.getframerate() * 180
                    and len(wav.readframes(frames)) == frames * wav.getnchannels() * wav.getsampwidth())
    except (wave.Error, EOFError, ValueError):
        return False


class SpeechStore:
    def __init__(self):
        self.approved = OrderedDict()
        self.audio = OrderedDict()
        self.audio_bytes = 0
        self.pending = {}
        self.waiters = Counter()

    def prune(self):
        now = time.monotonic()
        for key, (expires, _) in list(self.approved.items()):
            if expires <= now:
                del self.approved[key]
        for key, (expires, data) in list(self.audio.items()):
            if expires <= now:
                self.audio_bytes -= len(data)
                del self.audio[key]

    def issue(self, text):
        self.prune()
        token = secrets.token_urlsafe(32)
        self.approved[token] = (time.monotonic() + 120, text)
        while len(self.approved) > 128:
            self.approved.popitem(last=False)
        return token

    async def synthesize(self, token):
        self.prune()
        entry = self.approved.get(token)
        if not entry:
            record('tts_invalid_identifier')
            raise HTTPException(404, 'Speech identifier expired or unavailable')
        key = (entry[1], MODEL, VOICE, STYLE)
        if key in self.audio:
            record('tts_cache_hit')
            self.audio.move_to_end(key)
            return self.audio[key][1]
        if key not in self.pending:
            self.pending[key] = asyncio.create_task(self.generate(key))
        else:
            record('tts_deduplicated')
        task = self.pending[key]
        self.waiters[key] += 1
        try:
            # One canceled listener must not cancel synthesis for another listener.
            return await asyncio.shield(task)
        finally:
            self.waiters[key] -= 1
            if not self.waiters[key]:
                del self.waiters[key]
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                if self.pending.get(key) is task:
                    del self.pending[key]

    async def generate(self, key):
        try:
            async with asyncio.timeout(8):
                tts_budget.take()
                text, model, voice, style = key
                async with httpx.AsyncClient(timeout=8) as client:
                    async with client.stream('POST', 'https://generativelanguage.googleapis.com/v1beta/interactions',
                            headers={'x-goog-api-key': os.environ['GEMINI_API_KEY']}, json={
                                'model': model, 'store': False,
                                'input': [{'type': 'user_input', 'content': [{'type': 'text', 'text': text, 'annotations': [
                                    {'type': 'speech_metadata',
                                     'style': style}]}]}],
                                'generation_config': {'speech_config': [{'voice': voice}]},
                                'response_format': {'type': 'audio', 'mime_type': 'audio/wav'},
                            }) as response:
                        if response.status_code == 429:
                            tts_budget.cooldown(response.headers.get('Retry-After'))
                        response.raise_for_status()
                        # Bound encoded JSON before parsing, as well as decoded audio.
                        chunks = bytearray()
                        async for chunk in response.aiter_bytes():
                            chunks.extend(chunk)
                            if len(chunks) > MAX_AUDIO * 4 // 3 + 65536:
                                raise ValueError('Audio response too large')
                import json
                result = json.loads(chunks)
                parts = [part for step in result.get('steps', []) if step.get('type') == 'model_output'
                         for part in step.get('content', []) if part.get('type') == 'audio']
                if result.get('status') != 'completed' or len(parts) != 1 or parts[0].get('mime_type') != 'audio/wav':
                    raise ValueError('Invalid audio response')
                audio = base64.b64decode(parts[0]['data'], validate=True)
                if not valid_wav(audio):
                    raise ValueError('Invalid WAV')
                self.prune()
                self.audio[key] = (time.monotonic() + 1800, audio)
                self.audio_bytes += len(audio)
                while len(self.audio) > 128 or self.audio_bytes > MAX_AUDIO:
                    _, (_, removed) = self.audio.popitem(last=False)
                    self.audio_bytes -= len(removed)
                return audio
        except asyncio.CancelledError:
            record('tts_cancelled')
            raise
        except Exception as error:
            reason = 'timeout' if isinstance(error, (TimeoutError, httpx.TimeoutException)) else 'unavailable'
            if isinstance(error, ProviderUnavailable) or isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 429:
                reason = 'quota'
            if isinstance(error, (ValueError, KeyError, binascii.Error, TypeError)):
                reason = 'invalid_audio'
            record('tts_fallback_' + reason)
            # Provider response bodies must never escape into logs or HTTP errors.
            raise HTTPException(429 if reason == 'quota' else 503, 'Remote speech unavailable; use browser speech',
                                headers={'X-Speech-Fallback': reason}) from None


speech_store = SpeechStore()
