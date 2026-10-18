# Natural-language transit routing

Gemini interprets free-form transit questions; deterministic bus-service code resolves stops, vehicles, patterns, distances, and predictions.
Complete supported commands use explicitly labeled local transit tools without provider calls, including during a Gemini cooldown.
Ordinary questions never attach camera images.

## Supported interactions

- "How far away is bus 1 from Tigert Hall stop?"
- "How far is vehicle 1604 from stop 0441?"
- "When does that bus arrive?" after selecting a bus/stop query.
- "Tell me more about this route" or "Tell me more about that route."
- "Take me to Reitz Union," followed by "Take the second option" or "Less walking."
- "I'm on route 1," with a vehicle choice if several buses match.
- "I'm on vehicle 1604," followed by a destination request or "What are the next stops?"
- "I got off the bus," "Close the map," and "Cancel guidance."

"Bus 1" means route 1; a specific vehicle requires its ID or an explicit focused/selected reference.
Gaze does not imply boarding: only an explicit declaration records the onboard vehicle, and the application cannot independently verify physical boarding.
"Take me here" or "there" requires a known destination or selected stop; otherwise the assistant asks where.

## Bus-service APIs

`GET /api/buses/stop-distance?routeId=1&stop=Tigert%20Hall` resolves a stop and returns at most six matching vehicles.
Pass `busId` instead of `routeId` for one vehicle, and an exact stop ID to disambiguate a name.
Stop IDs remain strings with leading zeros; opposite-side stops remain distinct choices.
The response separates catalog and vehicle status/retrieval time, demo mode, straight-line distance, optional distance along the route, and vehicle-specific predictions.
Progress is `approaching`, `passed`, `not_served`, or `unknown`.
Distance along a route requires an exact reported pattern and conservative position matching.
Matching rejects positions over 75 meters from the shape, reverse headings above 2 mph, repeated-stop occurrences, and ambiguous loop projections.
Competing projections within 25 meters of the best match and over 200 meters apart along the pattern are ambiguous.
These thresholds are heuristics, not physical-device acceptance evidence.
Stale or partial geometry cannot confirm progress, and a passed stop does not imply an upcoming next lap.
Predictions match stop, route, direction, and vehicle ID; per-vehicle queries share a bounded 30-second upstream-row cache.
Distance and speed never generate an ETA.

`GET /api/buses/route-details?routeId=1` returns patterns and reported vehicles.
Pass `busId` to request a specific vehicle and its next stops when position and pattern are unambiguous.
Unknown progress produces pattern endpoints rather than invented next stops.

`GET /api/buses/plan` retains destination/position parameters and adds optional `onboardBusId`.
Direct trips retain the 0.8 km straight-line boarding-stop limit, route direction, exact pattern, matched vehicles, predictions, and freshness.
Active counts match the pattern rather than the route number alone.
A prediction can recommend a trip only when its vehicle matches that trip's pattern.
Among displayed options with evidence of upcoming service, the nearest boarding stop is recommended; this is not proof of the fastest trip or that the user can catch it.
Without upcoming-service evidence, coverage options require explicit selection before guidance starts.
Onboard travel considers only downstream stops on the explicitly selected vehicle's pattern and points the HUD toward the alighting stop.
Stale data and uncertain positions cannot establish onboard travel.
Known destination aliases and actual RTS stop names are supported; general address geocoding, transfers, pedestrian turn-by-turn routing, and background alerts remain outside this implementation.

## State, refresh, and requests

The new allowlisted actions are `show_bus_stop`, `show_bus_choices`, and `set_onboard_bus`.
Phone, Cardboard, and casting consume the same validated state and map frame.
Closing the map preserves selection; canceling guidance preserves an onboard declaration until the user says they got off.
Selected bus/stop observations refresh every 30 seconds without Gemini calls, retain stale positions on failure, and ignore late responses for a superseded selection.
Session/request IDs provide bounded single-flight processing and response replay for identical retries for 60 seconds, with at most 128 entries.
Reusing an ID for different request content in the same session returns HTTP 409.

## Verification commands

In `voice-service`, install `.venv/bin/pip install -r requirements-dev.txt`, then run `.venv/bin/python -m pytest -q`.
Cross-service tests exercise real bus API handlers through ASGI transport with captured fixtures and no provider calls.
Run `.venv/bin/python -m unittest discover -s tests -q` in `bus-service`, `npm test` and `npm run build` in `web`, and `npm run build` in `app/android`.
Physical iPhone speech, headset/outdoor alignment, and Android APK acceptance remain separate checks.
