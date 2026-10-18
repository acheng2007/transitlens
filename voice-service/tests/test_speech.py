"""Approved speech, caching and cancellation regressions."""
import asyncio
import base64
import io
import json
import wave
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
import speech


def wav_bytes():
    out = io.BytesIO()
    with wave.open(out, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b'\0\0' * 240)
    return out.getvalue()


def test_identifiers_are_random_expiring_bounded_and_arbitrary_text_is_rejected(monkeypatch):
    now = [10.0]
    monkeypatch.setattr(speech.time, 'monotonic', lambda: now[0])
    store = speech.SpeechStore()
    first, other = store.issue('Route 38.'), store.issue('Route 38.')
    assert len(first) == 43 and first != other
    for _ in range(128): store.issue('Approved answer')
    assert len(store.approved) == 128 and first not in store.approved
    now[0] += 121
    store.prune()
    assert not store.approved
    client = TestClient(main.app)
    assert client.post('/api/voice/tts', json={'text': 'Unapproved arbitrary text'}).status_code == 422
    assert client.post('/api/voice/tts', json={'speechId': 'a' * 43}).status_code == 404
    assert client.post('/api/voice/tts', json={'speechId': other, 'text': 'injected'}).status_code == 422


@pytest.mark.asyncio
async def test_expired_identifier_cannot_use_existing_audio(monkeypatch):
    store = speech.SpeechStore()
    token = store.issue('Route 38.')
    store.approved[token] = (0, 'Route 38.')
    store.audio[('Route 38.', speech.MODEL, speech.VOICE, speech.STYLE)] = (float('inf'), wav_bytes())
    with pytest.raises(HTTPException) as error:
        await store.synthesize(token)
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_rest_shape_valid_wav_cache_and_expiry_without_extra_quota(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(speech.time, 'monotonic', lambda: now[0])
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    calls = []
    wav = wav_bytes()
    def provider(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert request.url.path == '/v1beta/interactions'
        assert payload['store'] is False
        assert payload['model'] == 'gemini-3.8-flash-lite-tts'
        assert payload['generation_config']['speech_config'] == [{'voice': 'Sulafat'}]
        assert 'delivery' not in payload['response_format']
        assert payload['input'][0]['content'][0]['annotations'][0]['style'] == speech.STYLE
        assert payload['response_format']['mime_type'] == 'audio/wav'
        return httpx.Response(200, json={'status': 'completed', 'steps': [
            {'type': 'model_output', 'content': [{'type': 'audio', 'mime_type': 'audio/wav',
                'data': base64.b64encode(wav).decode()}]}]})
    real = httpx.AsyncClient
    monkeypatch.setattr(speech.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(provider), **kw))
    store = speech.SpeechStore()
    assert await store.synthesize(store.issue('Route 38.')) == wav
    assert await store.synthesize(store.issue('Route 38.')) == wav
    assert len(calls) == 1 and len(speech.tts_budget.starts) == 1
    now[0] += 1801
    assert await store.synthesize(store.issue('Route 38.')) == wav
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_simultaneous_generation_deduplicates_and_last_listener_cancels(monkeypatch):
    store = speech.SpeechStore()
    entered, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def generate(key):
        entered.set()
        try:
            await release.wait()
            return wav_bytes()
        finally:
            cancelled.set()
    mocked = AsyncMock(side_effect=generate)
    monkeypatch.setattr(store, 'generate', mocked)
    a = asyncio.create_task(store.synthesize(store.issue('Route 38.')))
    b = asyncio.create_task(store.synthesize(store.issue('Route 38.')))
    await entered.wait()
    a.cancel()
    await asyncio.gather(a, return_exceptions=True)
    assert not cancelled.is_set()
    release.set()
    assert await b == wav_bytes()
    assert mocked.await_count == 1
    release.clear(); entered.clear(); cancelled.clear()
    c = asyncio.create_task(store.synthesize(store.issue('Different approved answer.')))
    await entered.wait()
    c.cancel()
    await asyncio.gather(c, return_exceptions=True)
    assert cancelled.is_set() and not store.pending


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [429, 500, 200])
async def test_provider_failure_or_invalid_audio_never_retries(monkeypatch, status):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    calls = []
    def provider(request):
        calls.append(request)
        return httpx.Response(status, headers={'Retry-After': '120'}, json={'status': 'completed', 'steps': []})
    real = httpx.AsyncClient
    monkeypatch.setattr(speech.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(provider), **kw))
    store = speech.SpeechStore()
    with pytest.raises(HTTPException):
        await store.synthesize(store.issue('Approved answer.'))
    assert len(calls) == 1 and not store.audio
    if status == 429:
        with pytest.raises(HTTPException):
            await store.synthesize(store.issue('Another approved answer.'))
        assert len(calls) == 1


def test_truncated_or_unbounded_wav_is_rejected():
    audio = wav_bytes()
    assert speech.valid_wav(audio)
    assert not speech.valid_wav(audio[:-2])
    assert not speech.valid_wav(b'not audio')
    assert not speech.valid_wav(b'RIFF' + b'\0' * 50)


@pytest.mark.parametrize('key', ['', 'test-placeholder'])
def test_grounded_local_answers_can_use_natural_audio_without_text_inference(monkeypatch, key):
    monkeypatch.setenv('GEMINI_API_KEY', key)
    model = AsyncMock(side_effect=AssertionError('No inference for a complete local route question'))
    monkeypatch.setattr(main, 'ask_gemini', model)
    resolve = AsyncMock(return_value=('Route one serves this stop.', [], True, None))
    monkeypatch.setattr(main, 'resolve_intent', resolve)
    result = TestClient(main.app).post('/api/voice/ask', json={
        'requestId': f'natural-local-{bool(key)}', 'question': 'Tell me more about this route',
        'context': {'selectedRouteId': '1'},
    }).json()
    assert result['source'] == 'local'
    assert bool(result['speechId']) == bool(key)
    if key:
        assert main.speech_store.approved[result['speechId']][1] == result['answer']
    model.assert_not_awaited()


@pytest.mark.parametrize('question, expected', [
    ('open the map', 'Map expanded.'),
    ('close the map', 'Map returned to compact view.'),
    ('zoom out', 'Map range updated.'),
    ('cancel guidance', 'Guidance canceled. Back to exploring.'),
])
def test_short_controls_issue_approved_confirmations_without_inference(monkeypatch, question, expected):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    model = AsyncMock(side_effect=AssertionError('No inference for controls'))
    monkeypatch.setattr(main, 'ask_gemini', model)
    result = TestClient(main.app).post('/api/voice/ask', json={
        'requestId': 'spoken-control', 'question': question,
    }).json()
    assert result['speechText'] == expected
    assert main.speech_store.approved[result['speechId']][1] == expected
    assert not speech.tts_budget.starts  # Approval is lazy, not an audio generation.
    model.assert_not_awaited()


def test_clarifications_use_gemini_speech_but_service_errors_do_not(monkeypatch):
    from intents import Intent
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    monkeypatch.setattr(main, 'local_intent', lambda *args: Intent(scope='clarify', intent='none', answer='Which route do you mean?'))
    client = TestClient(main.app)
    req = {'requestId': 'spoken-clarify', 'question': 'that route'}
    result = client.post('/api/voice/ask', json=req).json()
    assert result['speechText'] == 'Which route do you mean?'
    assert result['speechId']
    monkeypatch.setattr(main, 'local_intent', lambda *args: None)
    monkeypatch.setattr(main, 'ask_gemini', AsyncMock(side_effect=TimeoutError()))
    result = client.post('/api/voice/ask', json={**req, 'requestId': 'spoken-error'}).json()
    assert result['speechId'] is None


def test_spoken_transcript_preserves_demo_labels_and_never_speaks_activation():
    from speech_text import approved_speech_text
    text = approved_speech_text('Scripted demo data. Say Hey Gemini for another question.', [])
    assert text == 'Scripted demo data. Say the assistant for another question.'


def test_tts_generation_limit_is_configurable_and_validated(monkeypatch):
    from provider_usage import configured_tts_limit
    monkeypatch.delenv('GEMINI_TTS_GENERATIONS_PER_MINUTE', raising=False)
    assert configured_tts_limit() == 10
    monkeypatch.setenv('GEMINI_TTS_GENERATIONS_PER_MINUTE', '25')
    assert configured_tts_limit() == 25
    for invalid in ('0', '-1', '121', 'nan', ''):
        monkeypatch.setenv('GEMINI_TTS_GENERATIONS_PER_MINUTE', invalid)
        assert configured_tts_limit() == 10


@pytest.mark.asyncio
async def test_style_changes_invalidate_audio_cache(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-placeholder')
    store = speech.SpeechStore()
    old_key = ('Route 38.', speech.MODEL, speech.VOICE, 'Old style')
    store.audio[old_key] = (float('inf'), wav_bytes())
    generated = AsyncMock(return_value=wav_bytes())
    monkeypatch.setattr(store, 'generate', generated)
    await store.synthesize(store.issue('Route 38.'))
    generated.assert_awaited_once_with(('Route 38.', speech.MODEL, speech.VOICE, speech.STYLE))
