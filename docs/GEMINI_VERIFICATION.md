# TransitLens copilot and showcase verification

This checkpoint extends the initial focused-bus integration into a complete direct-trip interaction.
It includes live RTS route patterns and stops, route discovery, highlighting, arrival prediction retrieval, trip choices, boarding-stop cues, explicit visual sign reading, handheld rendering, a revised launch experience and a synthetic showcase mode.
Gemini uses Google's server-side GenAI SDK and validated function calls; browser recognition and synthesis supply speech.
The model is configurable and defaults to `gemini-3.8-flash`.

## Automated validation

The final check commands are:

```sh
cd web && npm test && npm run build
cd ../voice-service && .venv/bin/python -m pytest tests -q
cd ../bus-service && .venv/bin/python -m unittest discover -s tests -q
cd ../app/android && npm run build
```

There are 22 web tests, 16 voice-service tests and 18 bus-service tests.
They cover wake matching, bounded follow-up capture, gaze snapshots, stale replies, canceled sessions, nested action/geometry validation, unknown/reversed stop IDs, arrival freshness, synthetic source labels, camera payload bounds, actual SDK tool/image types, ordered direction-sensitive trips, ambiguous destinations, no direct service, provider failure, catalog/prediction caches and the shared daily request counter.
The preexisting transit projection, compass, orientation, feed lifecycle and casting regression tests remain included.
Web and inherited Android compatibility production builds pass.
The Android native entry point itself still uses the inherited aircraft app; the new bus experience is the web application.

The web build retains existing Vite configuration and bundle-size warnings.
Python test clients report a Starlette/httpx adapter deprecation warning.
The inherited Android dependency audit findings are outside this feature scope.
`git diff --check` and shell launcher syntax checks are part of final verification.

## Live RTS evidence

On October 16, 2026, the provided server-only RTS credential retrieved 27 routes and 37 normalized current patterns.
A subset of six routes and 739 geometry points was captured as public demo route geometry.
Only route geometry/stops are captured; demo vehicles and arrivals are synthetic.

A live search for Shands returned geographically separate named stops and an explicit clarification result.
Selecting Shands Hospital at Davis Cancer Pavilion produced a direct route 37 outbound option boarding at Reitz Union at McCarty Drive.
RTS returned a matching stop/route/direction arrival prediction of 16 minutes during that check.
That observation is transient, not a promise about current service or an arrival to hardcode.
Another option lacked a usable prediction and retained an unavailable label.
The same live trip query succeeded through the voice-service local-tool path with a validated `show_journeys` action.

Live mode never substitutes a demo catalog or synthetic vehicle snapshot on failure.
The key is held only in the ignored, mode-0600 `bus-service/.env` file.
Network and prediction requests remain server-side.

## Browser and launcher evidence

The single launcher starts bus-service on 8003, voice-service on 8002 and Vite on the configured web port.
The desktop preview uses `?dev=1&camera=off&demo=1`, the fixed public Reitz Union location and microphone recognition disabled.

The revised launch screen exposes Cardboard and full-screen Handheld, live/demo data selection, speech, casting and retained calibration controls.
The handheld demo shows synthetic moving buses, the compass, map and clear source labels.
The route-to-Shands prompt traversed the Vite proxy and local voice service, displayed a route 38 option with real captured stop names, and labeled its four-minute arrival as scripted demo data.
Selecting that option started stationary-stop guidance with the route overlay, boarding/destination markers and approximate bearing/distance.
The interface labels the bearing cue as not a walking path.
Close/cancel restore compact exploration and clear the trip selection.
The initial stereo implementation was previously checked for shared map/subtitles; the expanded checkpoint also checks both rendering modes in desktop previews.

The separate fake-microphone harness remains available for deterministic wake-transcript checks.
Ordinary questions attach no image; a deliberate sign-reading request attaches one JPEG still with a maximum side of 640 pixels.
Camera-free mode reports that the camera is unavailable for sign reading.
Images are not retained in conversational history or logged.

## Remaining acceptance gates

A Gemini key was intentionally left blank for the user to fill in later.
Live Gemini speech interpretation, model tool selection and visual sign-reading quality have not been tested against the provider.
SDK model/configuration/image/tool contracts and request/action paths are covered by mocked tests.
The no-key path is explicitly labeled local/scripted and does not claim to be live Gemini.

Real microphone recognition and audible playback on phones, physical Cardboard fusion, iPhone/Android outdoor sensor alignment, actual camera sign legibility and a phone-to-laptop casting session remain hardware acceptance gates.
Browser speech recognition may use a network speech service and does not become offline just because the transit fixture is local.
Turn-by-turn pedestrian paths, transfer planning and a comprehensive timetable-based journey planner are not implemented.
The current planner checks direct ordered patterns and straight-line boarding distance, then exposes available matching RTS predictions separately.
