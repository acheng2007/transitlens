# Gemini transit service

FastAPI on port 8002 handles `POST /api/voice/ask`, `POST /api/voice/tts`, and `GET /api/voice/health`.
The phone uses browser speech recognition, the server uses the existing Google GenAI text SDK, and approved normal Gemini and deterministic transit answers, clarifications and successful confirmations use Gemini TTS with browser speech fallback when a key is configured.
Refusals, service errors and unavailable Gemini audio use browser speech.
The Gemini API key remains server-side.
No OpenRouter or Vertex integration is used.

## Run

```sh
cd voice-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set GEMINI_API_KEY in .env using a Google AI Studio key.
uvicorn main:app --host 127.0.0.1 --port 8002 --reload
```

Run bus-service on port 8003 and web on port 5173.
`BUS_SERVICE_URL` overrides the trusted bus-service origin and cannot be supplied by the browser.
`GEMINI_MODEL` defaults to `gemini-3.5-flash-lite` and must support JSON structured output and minimal thinking.
Text generation retains the existing SDK integration; TTS uses a server-side REST adapter for the documented Interactions API.
`GEMINI_FALLBACK_MODEL` is no longer used.
Neither SDK retries, application retries nor model fallback are enabled.

Use a key from a Google project marked **Free tier** in AI Studio for free usage.
Google currently lists free-tier input and output for `gemini-3.8-flash-lite-tts`; quota and project eligibility still apply.
Application settings cannot force free billing when the key belongs to a paid project.
This change does not modify credentials, project billing or authentication providers.
See [Google pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash-lite-tts).

## Bounded transit requests

```json
{
  "requestId": "example-1",
  "question": "Where is this bus going?",
  "context": {
    "focusedBusId": "2417",
    "position": {"lat": 29.6465, "lon": -82.3478},
    "radiusKm": 5,
    "map": {"mode": "compact", "extentKm": 5}
  },
  "history": []
}
```

The bus ID must exist in the current authoritative nearby snapshot.
The server retrieves facts rather than trusting client-supplied transit claims.
Location is used for deterministic transit queries and is not sent to Gemini.
The intent request contains bounded selection references and two short history turns, without transit facts.
After approval, the server retrieves only the transit data required by the chosen intent.
Routine bus facts use templates; explicit explanations receive only relevant selected bus facts or at most six nearby records, or compact retrieved journey results.
Ordinary questions send no images.
Explicit sign-reading requests may attach one bounded JPEG still; images are never retained in history.

Exact complete controls such as “close the map,” “zoom out,” and “cancel guidance” run before Gemini and transit retrieval.
Mixed requests never match this fast path.
Obvious unrelated and mixed coding requests are refused locally.
Other keyed requests receive one structured response combining scope, a supported intent, bounded arguments and an optional sign-reading or clarification answer.
Supported questions that need input return optional `clarification` metadata: `id`, `prompt`, `expected` (`route`, `stop`, `destination`, `vehicle`, or `choice`) and ISO `expiresAt`.
The client echoes its opaque ID as `context.clarificationId`; conversation history is no longer the authority for pending input.
The server keeps at most 128 immutable records for five minutes, bound to the requesting session and live/demo mode.
Each record preserves the original question, supported intent, known arguments, relevant selected IDs and authoritative candidate IDs.
Fresh location and transit data are used when completing a request.
Numbers, exact candidate names/IDs and bounded place labels resolve locally; free-form replies receive one constrained Gemini classification.
If classification identifies an explicit new request, the established intent interpreter handles it in a second call; this path skips an extra explanation generation to retain the two-call bound.
A route answer cannot turn a pending arrival request into a route description.
Ambiguous stop, destination, vehicle and trip choices use stored IDs rather than indexes in newly reordered results.

Map mode and zoom commands preserve pending input without extending its expiry.
An explicit new request replaces it; “never mind,” “cancel that question” and “cancel guidance” clear it.
Playback interruption preserves it, while a new application session or data-mode switch resets the client token and history.
Only a validated current response whose actions applied successfully can update client clarification state.
Provider/transit failures retain pending input; expired, evicted or mismatched tokens ask for the full request again without actions.
A server restart invalidates pending tokens.
The store is process-local, like the existing request cache; deployments with multiple workers need sticky routing or a shared store.
Older clients may omit the new fields and retain the stateless interface.
Service start/restart hours and operating timetables are unavailable; the assistant states that limitation and offers stop-specific live predictions instead.
There is no separate scope-classifier call and no mandatory context-tool round trip.
A refusal, invalid response or failed decision prepares no actions.

Supported intents cover bus information, direct-route discovery, highlighting, trip selection, boarding guidance, map controls and explicit bus-sign reading.
Deterministic code resolves route patterns, stops, direction, predictions and selected journey IDs.
Routine bus and journey replies use templates with explicit stale/partial data, ambiguity, unavailable predictions and straight-line stop distances.
Only an approved explicit explanation request can make a second text call over retrieved results.
The second response cannot carry actions, and failure keeps the deterministic result.
The interaction has at most two text calls under a 24-second application deadline, including any bus lookup with its own four-second timeout.
Each text call has a ten-second HTTP timeout, a 2,048-token output cap and no retries.
Dynamic transit answers and arrival results are not cached by the voice service.

Responses retain `requestId`, `answer`, `actions`, `source`, `demo` and `focusedBusId`, with optional `speechId` and approved `speechText`.
Actions remain allowlisted map mode/extent changes, grounded journey choices, verified route overlays, start guidance and clear guidance.
The client validates the entire batch and request identity before applying it to shared Cardboard, handheld and casting state.
Shared deterministic action-confirmation templates produce one approved spoken reply.
The client validates the approved transcript and applies actions before requesting speech; it never appends a device-voice confirmation to Gemini audio.
Stale replies, canceled sessions and superseded requests cannot apply actions or start audio.
Legacy voice consumers can continue using string answers; the transit application uses a structured speech result.

Without a key, a conservative full-command interpreter supports local controls, route IDs, simple named destinations and explicit option selections.
It does not execute partial free-form requests or impersonate Gemini.
Demo responses remain labeled synthetic/scripted, and live mode never falls back to demo data.
Transfer planning and verified pedestrian paths remain outside this implementation.

## Approved speech and playback

`POST /api/voice/tts` accepts only `{"speechId":"<issued identifier>"}` and returns `audio/wav`.
Arbitrary text, model names, voices and URLs are rejected.
Only the answer service can issue identifiers for approved normal answers, clarifications and successful action confirmations.
Identifiers use 32 random bytes, expire after two minutes, and occupy a process-local store of at most 128 entries.
An unknown, evicted or expired identifier cannot synthesize audio.

Speech is generated lazily after client validation and action application.
The adapter calls `https://generativelanguage.googleapis.com/v1beta/interactions` with `store: false`, WAV output, model `gemini-3.8-flash-lite-tts`, voice `Sulafat`, and the concise delivery style "Warm, casual, conversational."
The response format omits the unsupported `delivery` field, which previously caused HTTP 400 and forced browser fallback.
Voice style is metadata; approved transit text is read verbatim.
Browser fallback rechecks the available voices for each utterance, prefers enhanced or natural voices in the requested language, avoids novelty voices, and uses a relaxed 0.97 speaking rate.
Technical source labels remain visible but are omitted from speech; demo facts retain their spoken synthetic-data label.
No server-stored interaction or conversational audio chain is requested.
Provider synthesis has an eight-second deadline, the service request has ten seconds, and client download/playback startup has twelve seconds.
WAV headers, PCM metadata, frame count and audio size are validated server-side, with additional format and size checks in the browser.
Timeouts, quota exhaustion, malformed audio and playback failures fall back to browser speech without retrying.
The playback duration has its own stall guard rather than cutting off an answer at the synthesis deadline.

Audio caching keys include the exact approved transcript, model, voice and delivery style.
Entries expire after 30 minutes, with limits of 128 entries and 32 MB total.
Cache hits consume no provider budget, and simultaneous misses for the same key share a generation.
The last disconnected or canceled listener cancels in-flight synthesis.
New questions, `VoiceHandle.cancel()`, session exit and teardown abort pending client synthesis and stop playback; generation checks prevent late fallback speech.
Audio unlock stays inside the Start gesture and one phone audio element serves both eyes.
Recognition stays active for explicit wake detection through synthesis, remote playback and device speech.
Each question requires a fresh activation, with no automatic follow-up capture.
"Hey Gemini" interrupts the current answer and starts a new capture.
Playback status reports "Gemini voice" only after audio starts; failures report "Device voice" with allowlisted diagnostic reasons.
TTS failures include an `X-Speech-Fallback` reason without exposing provider response bodies.
Typed input remains available when browser recognition is missing or denied.

## Scope, quota and diagnostics

The transit-only policy applies to the complete request, attached images and history.
Unrelated requests, coding even about buses, secrets and policy overrides are refused without actions.
History, transit strings and images are untrusted data, never instructions.
Semantic scope checking reduces prompt-injection risk but cannot guarantee rejection of every adversarial input.

HTTP admission retains 60 requests per rolling minute and three simultaneous assistant requests per process.
Separate rolling provider budgets allow **12 text calls and ten TTS generations per minute by default** per process, including the optional second text call.
HTTP 429 starts a provider-specific cooldown honoring numeric or HTTP-date `Retry-After`, with a 60-second default when absent.
`GEMINI_TTS_GENERATIONS_PER_MINUTE` configures the TTS limit from 1 to 120; invalid values use ten.
Configuration is loaded before process-local budgets are constructed.
Cooldown and budget exhaustion cause local responses or browser speech, without retries.
Exact local controls and cached audio remain available during provider cooldown.
Counters and metadata-only log events record calls, cache hits, deduplication, cooldowns, cancellation and fallback reasons.
Keys, prompts, image data, answer text and speech identifiers are not logged.
These limits and stores reset on restart and are independent per worker; public deployments still need shared gateway and project quotas.
Health reports configuration, not verified provider connectivity.
Provider request and fallback categories are emitted as metadata-only `voice_event` logs.
Rate-limit responses state the remaining approximate wait, while map controls remain usable; timeout and invalid-response failures have separate messages.

Nearest-stop questions use the deterministic nearby-stop endpoint with the current location, including explicitly labeled demo data.
The answer names the nearest stop in the available catalog and reports straight-line distance and true-north bearing.
It does not select a journey, claim service to a destination, or draw a walking path.

## Verification status

Natural-routing verification passed 73 voice-service tests, including cross-service requests against real bus API handlers with captured data.
See [natural routing](../docs/NATURAL_ROUTING.md) for cross-service test setup, explicit onboard state, request deduplication, and new actions.

A free-form Gemini bus-distance request and deterministic direct-trip guidance were verified through the public phone URL and desktop UI.
Additional evidence and remaining device checks are recorded in [Gemini verification](../docs/GEMINI_VERIFICATION.md).
Browser speech recognition remains the speech-to-text provider and may depend on a network service.
Phone microphone, audible headset playback, stereo consistency and cast-network acceptance remain pending physical verification.

Provider references: [speech generation](https://ai.google.dev/gemini-api/docs/speech-generation), [Interactions REST schema](https://ai.google.dev/static/api/interactions.md.txt), [structured output](https://ai.google.dev/gemini-api/docs/structured-output).
