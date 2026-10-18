# Wake-gated natural voice checkpoint

Each explicit activation captures one question.
After the answer, TransitLens returns to wake-only standby and ignores ordinary background conversation.
There is no automatic follow-up capture window.
A greeting plus Gemini is required; bare Gemini mentions do not activate capture.

Saying "Hey Gemini" during thinking, synthesis or playback cancels the previous request and speech, freezes fresh gaze context and captures the next question.
Words following the activation in the same utterance are preserved.
Browser recognition stays active for wake detection through remote audio and device speech.
Result identities prevent late interim/final updates from reopening a submitted question.
The client ignores recognized fragments matching current spoken output, and approved speech replaces activation phrases to reduce speaker feedback.
These safeguards do not establish acoustic echo cancellation or prove physical Safari interruption works.

## Gemini speech and fallback

Normal grounded answers, clarifications and successful action confirmations can use Gemini TTS when a key and provider quota are available.
Complete deterministic questions still require no Gemini text-inference request.
Refusals, service failures and unavailable audio retain browser speech.
Shared deterministic templates prepare one approved spoken reply rather than appending a device-voice confirmation after Gemini audio.
The client validates the approved transcript and applies the supported actions before requesting audio.
Failed validation, failed application, stale replies and canceled requests cannot start success speech.
Synthetic transit facts retain their spoken demo label; technical source labels stay visible without being read aloud.

The server retains the documented Interactions WAV adapter, `gemini-3.8-flash-lite-tts`, Sulafat and `store: false`.
The delivery style is the concise "Warm, casual, conversational."
The unsupported `response_format.delivery` field remains absent.
Provider synthesis has an eight-second deadline, the service request has ten seconds, and client download/playback startup has twelve seconds.
Playback duration uses a separate stall guard.

`GEMINI_TTS_GENERATIONS_PER_MINUTE` sets the process-local audio generation budget from 1 to 120, defaulting to ten.
Provider cooldowns and quotas still apply independently of the twelve-text-calls-per-minute budget.
There are no automatic provider retries.
Approved identifiers expire after two minutes, with at most 128 entries.
The audio cache keys exact transcript, model, voice and style, expires after thirty minutes and remains bounded to 128 entries and 32 MB.

The typed speech-status callback reports preparation, actual playback, fallback, cancellation and unavailable device speech.
The shared HUD and assistant status distinguish "Gemini voice" from "Device voice" independently of answer provenance.
Allowlisted diagnostic reasons distinguish quota, service, timeout, network, invalid WAV and playback failures without logging prompts, audio, keys or speech identifiers.
Browser fallback rechecks device voices per utterance, preferring enhanced/natural voices in the requested language at a relaxed rate.
Its perceived quality depends on voices available on the device.

## Verification on October 17, 2026

- Before editing, the browser harness reproduced an unwanted second request from background speech after an answer.
- The original running service issued a speech identifier but returned HTTP 503 from TTS, demonstrating a path to device fallback.
- An isolated updated service generated a valid 109,796-byte Gemini WAV for "Map expanded." in 1.68 seconds.
- Browser integration exercised the real response validator, action dispatcher, TTS endpoint and audio element: expand the map, start Gemini playback, inject a fresh wake-plus-question during playback, cancel old audio, close the map, play the new confirmation and return to idle.
- Ordinary background speech after completion caused no additional request.
- All 66 web tests and 91 voice-service tests passed.
- Web production and Android shared-module builds passed.
- Desktop Cardboard visual review confirmed matching eyes, compass, focus card and persistent minimap.
- The web build also required removing an unused `aspect` argument that the map renderer did not consume; map rendering behavior was preserved.

Native APK packaging was attempted but could not proceed without JDK 21+; the expected local Android SDK setup was also absent.
Physical iPhone Safari recognition during playback, speaker feedback, audible interruption, perceived naturalness and headset audio remain pending acceptance checks.
Physical phone-to-laptop cast-network acceptance remains pending; automated casting and shared stereo rendering regressions pass.
The existing service on port 8002 must be restarted to load the changed server code and configuration.
The isolated verification service was separate from that running instance.
