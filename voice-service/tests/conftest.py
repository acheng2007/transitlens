"""Process budgets must not leak across isolated regression cases."""
import pytest
import main
import speech
from guardrails import RequestBudget
from provider_usage import ProviderBudget


@pytest.fixture(autouse=True)
def isolated_voice_state(monkeypatch):
    monkeypatch.setattr(main, 'request_budget', RequestBudget())
    monkeypatch.setattr(main, 'text_budget', ProviderBudget('text', 12))
    monkeypatch.setattr(speech, 'tts_budget', ProviderBudget('tts', 2))
    monkeypatch.setattr(main, 'speech_store', speech.SpeechStore())
    monkeypatch.setattr(main, 'clarification_store', main.ClarificationStore())
    monkeypatch.setattr(main, 'request_cache', main.RequestCache())
