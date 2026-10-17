# TransitLens agent instructions

## The product

TransitLens brings the aircraft-identification interaction of the original project to Gainesville RTS buses.
The user describes the desired feel as similar to Sky-C2, with a transit HUD that feels like a video game.
That is a product direction, not a dependency on another project's implementation.

Put a phone in Google Cardboard, look down the street, identify buses by their real geographic direction, and ask Gemini to help explore routes and reach a boarding stop.
The experience combines a top compass, route-first bus markers, gaze-selected information cards, a persistent bottom minimap, and a voice-controlled transit companion.
Mobile AR is a secondary renderer of the same experience.

The geographic Cardboard MVP remains the first engineering checkpoint.
The intended product also includes Gemini-driven route discovery and map interaction as core functionality, not a disposable stretch feature.
Do not remove the inherited voice stack or minimap during migration.

Read [README.md](README.md), [the PRD and its product update](docs/PRD.md), and [the implementation roadmap](docs/ROADMAP.md) before changing behavior.
This file governs work in this repository.
Use this file for current project instructions and [the parallel work plan](docs/PARALLEL_WORK.md) for collaborator assignments.
Upstream aircraft contracts, named ownership restrictions, and obsolete product priorities do not govern TransitLens.
The current user's instructions take precedence over repository guidance.

## Current state and immediate scope

The imported application still tracks aircraft.
TransitLens behavior described below is a target unless a completed milestone demonstrates otherwise.
An RTS credential smoke test returned routes and live vehicles, but a TransitLens bus service and Gemini transit actions have not been implemented.

Do not infer that documentation work authorizes implementing the application.
When implementation is requested, follow the roadmap and stop at the requested checkpoint.
The first migration checkpoint is the Bus model, Gainesville fixture, and bus-focused Cardboard HUD before changing the live data service.

## Non-negotiable experience

1. Cardboard comes first, with synchronized camera and HUD views in both eyes.
2. Preserve the existing compass at the top and minimap at the bottom.
3. Keep the central view clear in normal AR mode.
4. Make route number the strongest bus identifier; show destination and available transit metadata on focus.
5. Use head direction and dwell for selection without requiring taps inside the headset.
6. Preserve the wake-phrase interaction and spoken feedback, changing the planned activation phrase to "Hey Gemini" during migration.
7. Let Gemini change the interface through structured actions, as well as answer questions.
8. Keep demo mode, desktop development, calibration, Android compatibility, and laptop casting operational.

The game-like feel comes from responsive markers, stable target highlighting, a useful minimap, route overlays, waypoint cues, and clear feedback when commands take effect.
Do not add unrelated game systems, points, accounts, or cosmetic clutter.

## Gemini as a transit copilot

Example requests the product should eventually support:

- "Hey Gemini, what bus is that?"
- "Does this bus go to Shands?"
- "Show me all routes that go to Reitz Union."
- "Enlarge the minimap and show routes around me."
- "Highlight route 38."
- "Guide me to the nearest stop for that route."
- "Zoom out."
- "Close the map."
- "Cancel guidance."

"This bus" refers to the shared focused vehicle.
"That route" can refer to a deliberately selected route from the previous interaction.
Resolve destinations to actual places and relevant stops before claiming service coverage.
Ask a short spoken clarification when the destination, direction, or route choice is ambiguous.
Keep conversational context explicit and bounded rather than relying on the model to guess hidden UI state.

Route discovery must consider stop locations, route direction, patterns, and available service information.
Clearly distinguish routes that serve a destination from buses operating now and verified arrivals.
If only direct routes are supported, say so instead of presenting the result as every possible journey.
Begin with direct-route discovery and guidance to a boarding stop; a general transfer-based journey planner is not required.

Guide toward a stationary boarding stop, not toward a moving bus.
Use verified pedestrian paths for turn-by-turn guidance.
Without routing data, show an approximate stop bearing and distance and label it as directional guidance.
Do not present a straight line as a walkable path or invent directions across buildings or roads.
Support the complete voice interaction while the wearer is stationary; assess walking guidance using handheld mode or an appropriate test setup rather than requiring someone to walk with a camera headset.

## Interaction and minimap state

Keep one shared application state for focused bus, selected routes, selected stop, destination, map mode, zoom, and guidance.
Cardboard, mobile AR, and casting render that state rather than maintaining independent copies.
Compute gaze selection and dwell once per frame, not once per eye or canvas draw.

Use two map states initially:

- **Compact:** the persistent bottom minimap shows the user, heading/view cone, nearby buses, and selected route/stop cues.
- **Expanded:** a deliberately requested map view shows surrounding route geometry, stops, selected destination, and guidance context.

Expanded map mode must remain stereoscopically consistent in Cardboard.
It may occupy more view area while explicitly active; "close the map" returns to the compact HUD without losing the user's selection.
Voice subtitles must not silently remove the minimap as the inherited aircraft HUD currently does.
Arrange the transcript and answer so both remain usable.
Both eyes must share the same selection, map extent, orientation convention, zoom, and action result.

## Architecture and boundaries

```text
RTS vehicles + route patterns + stops + available predictions
                           |
                  server-side bus-service
                           |
                   shared transit state
                  /                    \
       heading + GPS + gaze       voice-service + Gemini
                  \                    /
              validated application actions
                           |
             shared view / map / guidance state
                           |
              Cardboard | Mobile | Casting
```

Adapt the existing Vite/plain TypeScript web app and FastAPI services.
Reuse `web/src/camera.ts`, `stereo.ts`, `orientation.ts`, and `geo.ts` rather than recreating the AR foundation.
Preserve headset lens spacing, zoom, FOV, tilt, horizontal shift, image size, smoothing, and sensor fallbacks.
Keep bus-service responsible for normalized transit data and deterministic route queries.
Keep voice-service responsible for conversation, tool orchestration, and spoken responses.
Use the Gemini API as the planned assistant provider, with a configurable model and server-side `GEMINI_API_KEY`.
Prefer Google's supported Python GenAI SDK for the transit tool integration; verify model support for function calling and structured output before selecting the model.
Preserve the existing browser speech-recognition and speech-synthesis pipeline initially.
The model provider, wake-phrase recognizer, and speech-output provider are separate concerns.
Replace the inherited xAI-specific remote speech path or disable it in favor of browser speech synthesis; do not send a Gemini key to an xAI endpoint.
Gemini speech generation can be added separately after the transit action loop works.
The imported source still uses Grok/xAI names and configuration until the application migration explicitly changes them.
Do not use an LLM to compute bus bearings, select gaze targets, calculate route reachability, or fabricate route geometry.

The server should supply authoritative route/stop search tools to Gemini.
Gemini interprets intent and requests tools; deterministic code resolves transit results.
The client applies only validated, supported UI actions against shared state.
An answer alone must not claim the map changed if no action was applied.

## Contracts to preserve and evolve

Use the PRD's `Bus` contract and `GET /api/buses/nearby` as the initial transit interface.
Use degrees clockwise from true north, normalized to `[0, 360)`, and kilometers internally.
Convert distance and speed explicitly for miles/mph display after verifying upstream units.
Keep optional destination, heading, speed, delay, and occupancy values nullable.
Unknown delay does not mean on time, and unknown speed does not mean zero.

Preserve signed angular difference, FOV filtering, and the existing pinhole projection.
Fetch all nearby bearings for per-frame heading updates and the minimap; do not limit the feed to the current camera cone.
Resolve the inherited Atlanta declination assumption through verified Gainesville calibration work, not an arbitrary constant change.

Evolve `/api/voice/ask` from aircraft text Q&A into transit conversation with a typed context and response envelope.
Suggested context includes a request ID, focused bus ID, relevant nearby bus IDs, selected route and stop IDs, resolved destination, map state, data freshness, and demo/live mode.
The server must validate IDs and resolve transit facts from trusted data rather than trusting client-supplied claims.

The intended response contains a short spoken `answer` plus validated `actions`.
Define an allowlisted discriminated union for actions such as:

- `set_map_mode` with compact or expanded mode.
- `set_map_zoom` within supported bounds.
- `highlight_routes` with authoritative route IDs and directions where needed.
- `select_stop` with an authoritative stop ID.
- `start_stop_guidance` with a resolved stop and available guidance result.
- `clear_guidance` to return to normal exploration.

These names describe the planned contract, not existing endpoints or implemented tools.
Specify exact schemas and shared types when implementing the feature.
Validate tool arguments, action payloads, IDs, and response shapes.
Never execute model-generated JavaScript, HTML, shell commands, arbitrary URLs, or arbitrary DOM selectors.
Associate actions with their originating request and current session; ignore stale responses and avoid duplicate application after retries.
Bound tool loops and timeouts so voice work cannot stall rendering.
Report the actual applied action or an understandable failure, with no new permission prompt for ordinary reversible map commands.

## Repository workstreams

| Path | Responsibility |
| --- | --- |
| `web/src/main.ts`, `hud.ts`, `format.ts`, `config.ts` | Lifecycle, shared interaction state, compass, transit HUD, minimap and calibration |
| `web/src/camera.ts`, `stereo.ts`, `orientation.ts`, `geo.ts` | Existing camera, sensor, stereo and projection foundation |
| `web/src/voice/` | Wake phrase, speech capture, voice lifecycle, responses and action dispatch integration |
| `voice-service/` | Server-side Gemini conversation, transit tools, typed actions and speech output |
| `flight-service/` transitioning to `bus-service/` | Server-side RTS integration, normalization, geometry, route/stop queries and cache |
| `shared/` | Transit fixtures and shared contracts as introduced during migration |
| `web/src/cast/`, `web/server/cast-signaling.ts` | Laptop casting using shared HUD and interaction state |
| `app/android/` | Native wrapper, sensor bridges and compatibility with imported web modules |
| `web/src/vr/` | Legacy virtual aircraft environment; retire only after checking references |

These are responsibility boundaries, not ownership assignments to the upstream team.
Make necessary cross-file contract changes coherently and document them in the same change.
If multiple contributors are active, respect their work and agree on shared interfaces before incompatible edits.
Do not spawn additional agents unless the user or an applicable task instruction explicitly requests delegation.

## Demo and failure behavior

Use 8-15 synthetic Gainesville buses around a fixed UF / Reitz Union location, with varied bearings and missing-metadata examples.
Demo ignores live GPS and preserves live orientation.
Extend demo data with route shapes, stops, and example destinations when route discovery and map actions are implemented.
Provide deterministic scripted voice-command inputs for development and demos without depending on live speech recognition or Gemini.
Clearly label those scripted responses as demo behavior.
Do not claim browser speech recognition or cloud Gemini works offline.

If RTS fails, retain available cached data, show freshness, and display `LIVE DATA TEMPORARILY UNAVAILABLE`.
Never silently substitute demo vehicles into Live RTS mode.
If voice fails, keep camera, compass, tracking, minimap, and existing selection working.
Keep browser speech synthesis as an available fallback when remote speech output fails.
Missing route or pedestrian data must yield a clear limitation rather than an invented route.

## Secrets and external services

Keep `RTS_API_KEY` in the bus service and `GEMINI_API_KEY` in the voice service.
Never put secrets in browser bundles, client environment variables, logs, committed configuration, screenshots, or examples.
Do not copy temporary credential files into the repository.
Use placeholder-only `.env.example` files and preserve `.env` exclusions.
Verify official provider documentation for endpoints, units, rate limits, available tools, and model capabilities before integration.
Do not assume the upstream aviation polling interval is suitable for RTS.
Limit voice context to information needed for the request; avoid transmitting the camera feed for features that need only structured transit context.

## Development and verification

Start the unchanged web baseline with `cd web`, `npm install`, then `npm run dev`.
Use `http://localhost:5173/?dev=1&data=fixture` for the inherited desktop fixture experience.
Run `npm run build` inside `web/` after relevant changes.
Use the upstream service READMEs for their current setup commands; document new bus-service commands when that service exists.
Ports currently are web `5173`, flight-service `8001`, and voice-service `8002`.

Check Android imports when changing shared web exports.
Run the relevant Android build, and `npm run apk` inside `app/android/` when the Android SDK/toolchain is available and native compatibility needs verification.
State toolchain limitations explicitly.

Begin bug fixes by reproducing the behavior end to end before editing code.
When that is unavailable, explain why and use the closest user-facing reproduction.
Inspect the UI closely and fix obvious, safe, reasonably scoped quality problems, mentioning additional fixes.
Verify stereo consistency, projection direction, compass wraparound, focus dwell, minimap behavior, and failure recovery.
For voice actions, verify transcript → intent → data tool → validated action → visible map change → truthful spoken result.
Include ambiguous places, wrong route IDs, wrong direction, stale replies, duplicate responses, missing routes, unsupported commands, and service failures.
Use focused tests for meaningful behavior and user-facing regressions rather than tests that merely mirror implementation.
Record phone, headset, outdoor alignment, and real speech tests as pending until actually performed.

## Quality, writing, and Git

Prioritize simplicity, quality, robustness, scalability, and maintainability over development cost.
Preserve working infrastructure and make reviewable changes instead of broad rewrites.
Keep documentation accurate about implemented versus planned functionality.
Never use em dashes in newly written content.
When writing substantially long Markdown files, put each complete sentence on its own line.

Use only the user's configured Git author and committer identity.
Never add an agent, AI, assistant, or tool identity as author, committer, co-author, or commit trailer.
After every commit, run `git log -1 --format='%an <%ae>%n%cn <%ce>%n%B'` and verify no agent or tool credit appears anywhere.
If tooling injects such credit, rewrite the commit and verify again before pushing.
