# Gemini transit service

FastAPI on port 8002 handles `POST /api/voice/ask` and `GET /api/voice/health`.
It uses Google's Python GenAI SDK with a configurable function-calling model.
The xAI chat and speech endpoints have been replaced; answers use browser speech synthesis.

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

Run bus-service on port 8003 with its server-side RTS key, and web on port 5173.
`BUS_SERVICE_URL` overrides the bus-service origin; it is never supplied by the browser.
`GEMINI_MODEL` defaults to `gemini-3.5-flash-lite` and must support function calling.
Health reports configuration, not successful provider connectivity.
Without a Gemini key, or on provider failure, replies explicitly say Gemini is unavailable and summarize only verified focused-bus data if available.
No camera frames or precise user coordinates are sent to Gemini.
The voice service uses user coordinates only to retrieve the nearby transit context from bus-service.
Browser speech recognition may use the browser vendor's network service.

## Contract

```sh
curl localhost:8002/api/voice/ask -H 'content-type: application/json' -d '{
  "requestId": "example-1",
  "question": "Where is this bus going?",
  "context": {
    "focusedBusId": "2417",
    "position": {"lat": 29.6465, "lon": -82.3478},
    "radiusKm": 5,
    "map": {"mode": "compact", "extentKm": 5}
  },
  "history": []
}'
```

The example ID must exist in the current RTS feed to resolve.
The service re-fetches the authoritative nearby snapshot rather than accepting client-supplied vehicle facts.
It provides `get_transit_context` and `set_map_view` tools to Gemini, preserving model content and thought signatures between calls.
The initial call requires the transit-context tool; subsequent calls can prepare map changes.
A request allows four model rounds, four tool calls per round, eight prepared actions, and twelve seconds of Gemini work.
Bus-service retrieval has a separate four-second timeout.
Unavailable, cached/stale, and older-than-90-second snapshots remain explicit.

Responses contain `requestId`, `answer`, `actions`, `source` (`gemini` or `local`), and the resolved `focusedBusId`.
Actions are restricted to `set_map_mode` (`compact` / `expanded`) and `set_map_extent` (0.1 to 400 km).
The browser validates the full batch before applying any action and replaces the model's map-change text with confirmation of the actual resulting UI state.
It rejects obsolete request IDs, canceled sessions, and superseded replies, and retains at most four conversational turns plus the previous verified bus ID.

The assistant can answer about reported destination, distance, speed, delay, occupancy, and nearby buses.
A destination headsign does not establish intermediate stop coverage.
Route discovery, route highlighting, arrivals, stop guidance, and pedestrian navigation need authoritative data/tools and are still pending.

## Verify

```sh
pip install pytest pytest-asyncio
python -m pytest tests -q
```

Tests use mocked RTS and Gemini responses, with real SDK model/configuration types.
Live Gemini, live RTS, microphone, physical phone/headset and outdoor alignment checks require separate verification.
Model and tool API references: [Google models](https://ai.google.dev/gemini-api/docs/models), [GenAI Python SDK](https://googleapis.github.io/python-genai/).
