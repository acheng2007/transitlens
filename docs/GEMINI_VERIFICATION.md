# Gemini focused-bus integration verification

The user-authorized Gemini slice connects the existing live RTS gaze target to voice and typed conversation.
It uses Google's supported Python GenAI SDK, bounded function calling, authoritative bus context, browser speech synthesis, and validated shared map actions.
This is a focused-bus and map-control slice of roadmap milestone 4a.
The broader route discovery and boarding-stop guidance milestone is not complete.

## Automated checks

- `cd web && npm test`: 17 tests passed, including five assistant tests and the existing transit/map/orientation/lifecycle regressions.
- `cd web && npm run build`: passed TypeScript and Vite production bundling.
- `cd voice-service && python -m pytest tests -q`: 12 tests passed using mocked RTS and Gemini with actual SDK config/content/response types.
- `cd app/android && npm run build`: passed TypeScript and Vite bundling for compatibility with inherited shared exports.
- `git diff --check`: passed.

The assistant tests exercise wake activation, gaze capture before turning away, transcript submission, grounded data-tool round trips, map-mode/extent application and truthful local confirmation.
They cover bounded follow-up history, unknown bus IDs, nullable destination/delay data, unavailable RTS, missing Gemini credentials, provider failure, malformed actions, nonfinite/out-of-range zoom, stale request IDs, superseded replies, stopped sessions, and typed questions after microphone denial.
No test calls a paid provider or claims to verify live model behavior.

The web build retains existing Vite configuration and bundle-size warnings.
The service tests report a Starlette warning about its httpx test adapter.
Android's existing dependency tree reports seven audit findings; dependency upgrades were outside this feature change.
No APK packaging was needed for this browser/service integration, and physical Android verification remains pending.

## Browser checks

A local Vite preview used `?dev=1&camera=off`, the fixed public Reitz Union location, and microphone recognition disabled.
The typed question panel opened from the mirrored Ask Gemini control.
Its example destination question reached the local voice endpoint and displayed the explicit Gemini/live-data-unavailable response with no configured service credentials.
Closing the panel returned to the active stereo HUD.
In a landscape viewport, both eyes showed the same compass, radar fallback, shared controls, transcript and answer, with the minimap beside the subtitles.
No camera or microphone permissions were requested during these checks.
The text panel was also visually checked in a narrow viewport.

The voice development harness was checked with a fake microphone and the typed transcript "Hey Gemini expand the map".
It completed listening, thinking and idle states and displayed "Scripted demo: map expanded, 5 kilometers." without cloud access.
The harness accepts deterministic typed wake transcripts and explicitly labeled synthetic responses without the cloud.
This is a development-only path; the main Live RTS application never substitutes scripted buses or Gemini responses.

## Pending acceptance

Live Gemini and live RTS replies require `GEMINI_API_KEY` in voice-service and `RTS_API_KEY` in bus-service.
No credentials were available in this checkout, so live provider behavior has not been verified.
Real microphone recognition, audible playback on phones, physical Cardboard, Android/iPhone sensor alignment, outdoor bus identity, and laptop casting remain device acceptance checks.
Casting consumes the same action/map/subtitle state by construction, but a physical WebRTC session was not tested here.

Try "Hey Gemini, where is this bus going?", then ask about delay or occupancy while holding a selected target.
Try a missing destination, turn away during the question, and ask about an intermediate stop such as Shands.
The answer should use the captured vehicle and acknowledge missing facts or unverified coverage.
Try expand, close, zoom in and zoom out, then stop/restart during a pending request.
Both eyes and casting should agree, and old replies must not apply after exit.
