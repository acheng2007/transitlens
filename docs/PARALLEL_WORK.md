# TransitLens parallel work plan

Use this document to assign bounded tasks to AI agents and human collaborators.
It describes remaining work, not features already delivered or authorization to implement every stream at once.
Read `AGENTS.md`, `README.md`, `docs/PRD.md`, and this plan before starting an assignment.

## Starting point

Implemented: live RTS vehicle service, bus HUD, shared dwell selection, Safari sensor handling, MapLibre/OpenFreeMap streets, compact/expanded maps, manual map actions, and a saved independent compass-distance filter defaulting to 1 mile.
The current map actions are `set_map_mode` and `set_map_extent` in `web/src/map-state.ts`.
The recorded verification includes 12 passing web tests, web and Android compatibility builds, matching eyes, local casting, and map failure fallbacks.
See [live-feed evidence](LIVE_RTS_VERIFICATION.md) and [street-map evidence](STREET_MAP_VERIFICATION.md).

Not implemented: Gemini transit conversation, transit route geometry and stop queries, destination resolution, route overlays, stop guidance, synthetic bus demos, and Mobile AR.
The native Android entry point still tracks aircraft.
The reported iPhone 16 Pro location success does not verify compass alignment, map acceptance, or headset fusion.
APK packaging is blocked by the missing JDK 21 toolchain.

## Assignment map

Use a separate branch for each workstream.
AI agents and human collaborators can work simultaneously within agreed file boundaries.

| ID | Category | Best fit | Primary paths | First useful delivery |
| --- | --- | --- | --- | --- |
| A | Shared contracts and integration | Lead developer + AI | `shared/`, `web/src/map-state.ts`, `web/src/main.ts`, shared settings/startup wiring | Reviewed contracts, request lifecycle, and integration seams |
| B | Transit data and deterministic discovery | Backend developer or AI | `bus-service/` | Authoritative route/direction/stop data and tested direct-service queries |
| C | Gemini backend and tool orchestration | Backend developer or AI | `voice-service/` | Typed answer/actions and bounded server-side tool loop |
| D | Browser voice interaction | Frontend developer or AI | `web/src/voice/` | Hey Gemini, speech lifecycle, typed transcript harness, browser speech fallback |
| E | Map overlays and HUD presentation | Frontend/graphics developer or AI | `web/src/street-map.ts`, `web/src/hud.ts`, map-specific styles | Shared route/stop/destination overlays and readable voice/map layout |
| F | Physical device and geographic acceptance | Human with phone/headset, assisted by AI | Evidence under `docs/verification/` | iPhone/headset observations with reproducible issues and measurements |
| G | Demo scenarios and end-to-end verification | QA developer or AI | New transit demo modules, `web/tests/`, backend test scenarios | Deterministic transit/voice scenarios and automated journey checks |
| H | Alternate renderers and delivery | Platform developer + AI | `web/src/stereo.ts`, `web/src/cast/`, `app/android/`, delivery tooling | Staged Mobile AR, phone-to-laptop casting validation, native packaging |

A integrates final edits to shared startup and state wiring.
B and C can add service-local test files, while G coordinates cross-service scenarios and browser end-to-end tests.
E and D should use separate style files for substantial new presentation work; A wires imports or agrees specific regions in `style.css` and `index.html` before concurrent edits.
F records findings and routes fixes to the relevant workstream to avoid concurrent edits to the same source files.
H's platform changes are staged separately, so native work does not force web renderer changes before they are ready.

## A. Shared contracts and integration

**Goal:** every renderer and voice command operates on one validated application state.

- Publish the next transit contracts: stable route ID, display route number, direction/pattern IDs, stop IDs, destination candidates, geometry, and freshness/provenance.
- Publish voice request/response schemas with request and session IDs, focused bus ID, nearby IDs, selected route/stop/destination, map mode/extent, data freshness, and demo/live mode.
- Preserve nullable metadata and distinguish service coverage, currently operating vehicles, and verified predictions.
- Extend the existing action reducer with allowlisted route, stop, destination, and guidance actions as needed.
Keep `set_map_extent` as the canonical existing map control; translate conversational zoom requests into bounded extent changes rather than adding a conflicting zoom state.
- Define client action results and server acknowledgment so speech describes actual application success or failure.
- Implement stale-reply rejection, cancellation, bounded context, and duplicate-response protection.
- Supply narrow interfaces that D and E can develop against without editing `main.ts`.
Keep the existing plain TypeScript architecture unless a concrete need justifies a change.

**Dependencies:** none for the initial contract review; consult B, C, D, and E before freezing interfaces.
**Acceptance:** invalid IDs/actions are rejected, ordinary map actions need no permission prompt, retries apply once, stale sessions cannot change the UI, and both eyes/cast render the same result.
**First assignment:** define and test the contract/reducer extension plus stub consumers; do not implement Gemini or route matching in this task.

## B. Transit data and deterministic discovery

**Goal:** authoritative transit facts can answer which direct routes serve a resolved place and where to board.

- Verify official provider documentation and actual responses for route patterns, directions, stops, shapes, available service data, upstream units, and request limits.
Record supported and unavailable capabilities before designing queries around them.
- Add normalized route/stop/pattern data and bounded caches without breaking `/api/buses/nearby` or its last-good vehicle behavior.
- Implement deterministic queries for route details, nearby stops, and direct service to resolved destination stops.
Consider direction, patterns, and available service information, not route-number or destination-string matching alone.
- Resolve place names to candidate places and relevant stops through a documented data source.
Return ambiguity explicitly so the assistant can ask a short clarification.
- Return stable authoritative IDs, geometry, source age, and clear missing-data results.
Keep `RTS_API_KEY` server-side and account for the additional upstream calls in the shared rate budget.

**Dependencies:** A's reviewed contract; provider access is needed for live acceptance.
**Acceptance:** cover ambiguous places, duplicate display route numbers, opposite directions, partial shapes, unknown stop/route IDs, inactive service, empty results, timeouts, stale cache, and recovery.
A direct-service result must not claim every possible transfer journey or an arrival.
**First assignment:** ingest and test route/stop/direction data, then expose deterministic query interfaces for C and E.

## C. Gemini backend and tool orchestration

**Goal:** Gemini uses trusted transit tools and returns a brief answer plus validated actions.

- Migrate the inherited aircraft/xAI conversation path to Google's supported Python GenAI SDK with server-only `GEMINI_API_KEY` and a configurable model.
Verify function-calling and structured-output support at implementation time.
- Use A's request/response contract and B's deterministic tools.
Resolve client IDs against trusted data and reject unsupported or unknown IDs.
- Bound tool calls, timeouts, context size, and cancellation.
Handle ambiguous destinations and route directions with clarification.
- Remove or disable the inherited xAI speech endpoint in the transit path.
D initially provides browser speech synthesis; remote Gemini speech is a separate later task.
- Coordinate with A and D on action acknowledgments so an answer does not claim the map changed before application succeeds.
Update health metadata, environment examples, service setup, and tests.

**Dependencies:** A for schemas; B for live transit tool behavior.
Development can begin with clearly labeled deterministic tool stubs after schema agreement.
**Acceptance:** test malformed model output, tool errors, unknown IDs, unsupported commands, ambiguous places, no service, timeouts, stale requests, and provider failure.
No model-generated code, arbitrary URL, selector, or command is executed.
**First assignment:** implement a map-only and focused-bus conversation slice before destination discovery and guidance.

## D. Browser voice interaction

**Goal:** the wearer can say Hey Gemini, hear a response, and observe the corresponding validated state change.

- Adapt wake matching, transit context, assistant labels, recognition lifecycle, and speech output.
Preserve the working speech-recognition infrastructure and use browser speech synthesis initially.
- Provide a typed-transcript development entry point that exercises the same request/action path as speech capture.
- Consume A's request dispatcher and application-result interface.
Leave shared startup/state wiring to A.
- Coordinate subtitle layout with E so listening, transcript, answer, errors, compass, and compact minimap remain usable together.
- Support cancel/retry, microphone denial, recognition unavailability, and provider failure without interrupting camera, tracking, or selection.

**Dependencies:** A's interface; C's envelope can be mocked during development.
**Acceptance:** real speech remains a human gate, while deterministic transcript tests cover the complete command lifecycle.
Browser recognition and cloud Gemini are never described as offline-capable.
**First assignment:** typed transcript to map expand/close/zoom, followed by wake phrase and speech capture/output.

## E. Map overlays and HUD presentation

**Goal:** selected transit routes, stops, destinations, and guidance are geographically coherent and readable in every view.

- Render authoritative route geometry, distinguish directions/patterns, and style selected routes consistently.
- Add distinct user, bus, stop, destination, and boarding-stop markers using the same map projection.
- Consume shared state rather than retaining private selections inside MapLibre or per-eye rendering.
Preserve one composite map frame, attribution, follow behavior, zoom bounds, and radar failure fallback.
- Keep expanded mode translucent and focused cards suppressed while expanded.
Arrange D's voice feedback around the persistent minimap and clear central compact view.
- Show approximate bearing/distance to a stationary boarding stop when pedestrian routing is unavailable.
Only show a walkable path or turn instructions when verified pedestrian routing supports them.

**Dependencies:** A for state/actions; B for real shapes and stops.
Rendering can start against G's clearly synthetic fixtures.
**Acceptance:** selected route/direction and stop agree across both eyes and casting; geometry stays aligned through heading wraparound, GPS movement, and zoom.
Missing geometry, heading, location, and tiles have explicit behavior.
**First assignment:** route and stop overlays from normalized fixture data, without implementing place search or Gemini logic.

## F. Physical device and geographic acceptance

**Goal:** establish what actually works on the target phone, headset, and network.

- Start on iPhone 16 Pro over HTTPS while stationary and handheld.
Record OS/browser, permission results, location accuracy, camera output, roads/live buses, Map/Close, and the independent 1-mile filter.
- Test portrait and both landscape directions, resize/toolbars, background/foreground, permission denial/retry, repeated start/stop, and device-specific size/FOV calibration.
- At known outdoor positions, compare independently checked bearings against compass and vehicle markers.
Record observed error and drift; agree an acceptable alignment threshold before declaring success.
- Test stationary headset fusion, dwell, neighboring targets, central visibility, compass readability, map legibility, and every calibration control.
- Test Android Chrome and phone-to-laptop casting on the intended network.
Walking guidance tests use handheld mode or another appropriate setup.

**Dependencies:** current application and physical access; start immediately.
New features receive another physical acceptance pass after integration.
**Acceptance:** evidence includes device, location test context, steps, expected/observed behavior, and pass/fail/pending status.
A screenshot, mocked compass, or passing build cannot close a physical gate.
**First assignment:** close or reproduce the currently pending street-map and live-Cardboard acceptance checks before tuning sensor code.

## G. Demo scenarios and end-to-end verification

**Goal:** collaborators can develop and demonstrate the same interactions without depending on live RTS, speech, or Gemini.

- Create 8-15 labeled synthetic Gainesville buses around fixed Reitz Union coordinates, with varied bearings, repeated route numbers, and missing metadata.
Derive geometry using the existing formulas and preserve live device orientation.
- After A's schema review, add synthetic stops, route patterns/shapes, destinations, and expected direct-service answers.
Keep synthetic geographic examples clearly distinct from verified RTS facts.
- Add scripted transcript/action scenarios for expand, zoom, highlight, clarification, boarding-stop selection, approximate guidance, cancel, and close.
Offline scripted output must be labeled demo behavior.
- Coordinate browser end-to-end coverage of action results, selection, map changes, stereo/cast consistency, stale replies, duplicate retries, and service failures.
Use fixture-fed services or explicit test injection rather than silent live-to-demo fallback.
- Capture reproducible bug reports before fixes, and preserve user-facing regression coverage for meaningful failures.
Document which loaded-app demo features work without network; street tiles still require network unless separately packaged.

**Dependencies:** A for fixtures beyond the current Bus shape; C/D/E for final interaction checks.
Initial bus fixtures and test harness design can start immediately.
**Acceptance:** deterministic results with network services blocked, visibly labeled demo mode, live mode never substituting demo data, and the same actions exercised by manual, scripted, and voice inputs.
**First assignment:** synthetic bus fixture and reproducible scenario harness, with A integrating the eventual mode selector/feed wiring.

## H. Alternate renderers and delivery

**Goal:** extend the shared experience after the geographic Cardboard foundation is accepted.

- First validate current casting on actual phone/laptop hardware and prepare a reproducible development setup with documented HTTPS and server-side secrets.
- After Cardboard acceptance, add Mobile AR as one full-screen renderer of the same feed, focus, map, and voice state.
Preserve camera FOV/crop math and avoid duplicate watchers, sessions, or MapLibre instances.
- Prepare JDK 21/Android SDK tooling and verify the inherited native compatibility/APK path.
A native bus migration is a separate explicitly assigned task; it is not implied by a passing Android build.
- If public hosting is requested, prepare reviewed service/proxy configuration, health checks, allowed origins, and deployment instructions.
The current in-memory RTS cache assumes one worker; shared caching/rate budgets and multi-session casting need a deliberate deployment design.

**Dependencies:** A's stable view interfaces and F's Cardboard gate for Mobile AR release.
Toolchain/setup and casting investigation can proceed now.
**Acceptance:** Cardboard regressions pass, renderer changes preserve angular alignment and shared selection, and real phone/laptop or native checks are recorded separately from builds.
**First assignment:** casting/device setup and Android toolchain readiness; keep Mobile AR and native migration in separate follow-up changes.

## Integration order

1. Start F's physical checks, B's provider/data investigation, G's fixture preparation, and H's setup work immediately.
A conducts a short interface review with B/C/D/E and lands the smallest shared contracts and test fixtures first.
2. Run B, C, D, and E concurrently against those contracts.
C starts with map-only commands and focused-bus facts; D uses typed transcripts before real speech; E uses synthetic shapes/stops before live data.
3. A integrates the first vertical slice: transcript → Gemini → validated map action → actual application result → truthful spoken feedback.
G verifies it, and F runs the physical check.
4. Integrate B's direct-route discovery, destination clarification, and E's route/stop overlays.
Then add boarding-stop selection and explicitly approximate guidance, followed by cancel/close behavior.
5. Release the transit copilot only after its full interaction/failure gate and the geographic Cardboard acceptance gate pass.
Add Mobile AR after that foundation; schedule arrivals, richer occupancy, verified pedestrian routing, and native bus migration as separate slices.

Contract work, mocks, and isolated development may proceed while physical acceptance is pending.
They do not waive physical gates or establish that untested features are ready for use.

## Collaboration rules and handoff template

Use separate clones or Git worktrees for concurrent AI sessions and collaborators.
Do not point multiple editing sessions at this same working directory.
Use branches such as `work/transit-data`, `work/gemini-service`, `work/browser-voice`, and `work/map-overlays`.
Merge reviewed contracts first and rebase dependent branches before integration.
Do not duplicate schemas, change another stream's API unilaterally, or let an agent merge unrelated work to resolve a conflict.
If a shared path must change, agree the interface and responsible workstream before editing.

Each assignment should copy this prompt and fill in the bracketed fields:

> Work only on stream [ID] and its first assignment in docs/PARALLEL_WORK.md.
> Read AGENTS.md, README.md, docs/PRD.md, and the relevant verification records.
> Deliver [specific user-visible outcome] on branch [branch], primarily in [relevant paths].
> Use contract revision [commit]; coordinate shared-file changes with stream A.
> Preserve Cardboard, compass, minimap, calibration, failure behavior, and Android compatibility.
> Begin bug fixes with a user-facing reproduction and run meaningful focused checks.
> Report changed interfaces, test evidence, remaining limitations, and hardware checks actually performed.
> Do not implement another stream, publish/deploy, or mark a physical gate complete without evidence.

A finished handoff includes the branch/commit, outcome, changed files/contracts, startup steps, test results, evidence links, and explicit pending checks.
Use only the user's Git identity and follow the repository's post-commit identity verification rule.
