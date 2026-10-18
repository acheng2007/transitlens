# TransitLens copilot and showcase verification

## Split wake phrase regression, October 18, 2026

The user reported no reaction to the wake phrase on iPhone Safari.
Before editing, a desktop browser with simulated recognition results reproduced an ignored command when speech arrived as separate finalized `Hey` and `Gemini close the map` results.
The same command worked when the activation arrived in one result.
The voice lifecycle now joins an isolated greeting with its next continuation within two seconds and preserves that activation through interim revisions and the final result.
Unrelated speech and expired greetings cannot supply an activation.
The browser check now opens the expanded map through split recognition results, the real voice HTTP endpoint, validated actions and the shared UI.
All 84 web tests and the web production build pass in the original checkout.
The deployment checkout preserves the newer discovery interface and passes all 86 web tests and the web production build.
Physical iPhone microphone recognition and confirmation of the user's specific failure remain pending.

## Natural routing implementation, October 17, 2026

The natural-routing slice passed 73 voice-service tests, 43 bus-service tests, and 39 web tests.
Web and Android shared-module production builds passed.
The Android APK was not built; the standard local Android SDK directory and `adb` were not available in the checked environment.
Cross-service tests exercise real bus API handlers with captured data, without spending provider quota.
They cover route/vehicle selection, stop ambiguity, downstream onboard trips, exact-pattern active counts, conservative progress matching, vehicle-specific predictions, stale data, request deduplication, context preservation, and late refresh suppression.

Chrome typed-input checks through the public phone URL exercised the user's exact Tigert Hall question and displayed real route 1 vehicles with passed-stop and non-serving-pattern distinctions.
A free-form paraphrase used one Gemini text decision and returned the same grounded bus-to-stop lookup with a visible map action.
"Take me to Reitz Union" recommended a boarding stop with current service evidence, highlighted the trip, and displayed arrival information and approximate stop guidance.
Desktop Cardboard inspection showed the same stop selection, distances, route overlay, map extent, and orientation in both eyes.
Road tiles failed in that Chrome session; the labeled radar fallback retained the transit overlays and both-eye consistency.
The start-screen greeting, heading, and description were visually rechecked after scoping an older conflicting launch-layout rule.
The final restarted services returned available stop queries and direct-trip plans through the phone tunnel.
New physical iPhone speech/onboard/outdoor tests, headset alignment, and cast-network acceptance remain pending.
See [natural routing contracts](NATURAL_ROUTING.md) for implemented behavior and limitations.

## Phone-test assistant follow-up, October 17, 2026

The laptop Firefox cast showed a real phone response using the generic assistant failure message.
The exact original exception could not be recovered because prior fallback logging did not identify it.
The user's open AI Studio rate-limit dashboard subsequently showed the free-tier text model had reached a peak of 15/15 requests per minute, consistent with rate-limit failures during testing; this dashboard reports a peak over the selected period rather than current remaining capacity.
Current public-URL requests successfully exercised Gemini nearest-stop lookup, route discovery to Reitz Union, selection of the first trip, and the returned stationary boarding guidance action.
Arrival questions without a specified stop now receive an explicit clarification in the live-provider check.
Nearest-stop lookup was previously absent from the assistant intent contract and is now supported through deterministic bus-service queries.
The schema compatibility fix uses `response_json_schema` to preserve strict JSON Schema fields without sending unsupported snake-case fields in the provider response schema.
Regression checks passed: 63 voice-service tests and 37 bus-service tests, including budget expiry/recovery, map controls during cooldown, nearest-stop location/empty/stale handling, and demo stop lookup without live calls.
Chrome typed-input verification through the public phone URL displayed the actual nearest-stop answer labeled Gemini API and rendered five selectable route choices for Reitz Union.
The web production build passed after correcting singular stop labels in the trip cards and HUD.
Phone microphone recognition, physical alignment, and the user's repeat test remain separate acceptance checks.

This checkpoint extends the initial focused-bus integration into a complete direct-trip interaction.
It includes live RTS route patterns and stops, route discovery, highlighting, arrival prediction retrieval, trip choices, boarding-stop cues, explicit visual sign reading, handheld rendering, a revised launch experience and a synthetic showcase mode.
Gemini uses Google's server-side GenAI SDK and validated function calls; browser recognition and synthesis supply speech.
The model is configurable and defaults to `gemini-3.5-flash-lite`, with model fallback now disabled by default at the user's request to use the Gemini API free tier.

## Automated validation

The final check commands are:

```sh
cd web && npm test && npm run build
cd ../voice-service && .venv/bin/python -m pytest tests -q
cd ../bus-service && .venv/bin/python -m unittest discover -s tests -q
cd ../app/android && npm run build
```

There are 22 web tests, 16 voice-service tests and 18 bus-service tests.
They cover wake matching, wake-gated question capture, gaze snapshots, stale replies, canceled sessions, nested action/geometry validation, unknown/reversed stop IDs, arrival freshness, synthetic source labels, camera payload bounds, actual SDK tool/image types, ordered direction-sensitive trips, ambiguous destinations, no direct service, provider failure, catalog/prediction caches and the shared daily request counter.
The preexisting transit projection, compass, orientation, feed lifecycle and casting regression tests remain included.
Web and inherited Android compatibility production builds pass.
The Android entry point uses the shared bus feed and transit HUD; physical native acceptance remains pending.

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

A Gemini key is now configured in the ignored server environment file.
The October 17 scope-guardrail check enabled the Gemini API in its project, but live generation still returned HTTP 403 because Google blocks this key's access to the GenerateContent method.
The authenticated account could not inspect key restrictions (HTTP 403).
On a subsequent retry after the user changed the key configuration, Google accepted access but required a minimum ten-second provider deadline.
Both SDK HTTP timeouts were corrected to ten seconds; the separate application deadlines still bound total work.
The next provider response was HTTP 402, reporting depleted prepayment credits.
Successful live generation remains blocked on the key project's AI Studio billing credits.
Live Gemini speech interpretation, model tool selection and visual sign-reading quality have not been tested against the provider.
SDK model/configuration/image/tool contracts and request/action paths are covered by mocked tests.
The no-key path is explicitly labeled local/scripted and does not claim to be live Gemini.

Real microphone recognition and audible playback on phones, physical Cardboard fusion, iPhone/Android outdoor sensor alignment, actual camera sign legibility and a phone-to-laptop casting session remain hardware acceptance gates.
Browser speech recognition may use a network speech service and does not become offline just because the transit fixture is local.
Turn-by-turn pedestrian paths, transfer planning and a comprehensive timetable-based journey planner are not implemented.
The current planner checks direct ordered patterns and straight-line boarding distance, then exposes available matching RTS predictions separately.

## Integration with latest main

The direct-to-main integration preserves the newer `/api/transit` catalog, stop queries, direct-service endpoints and focused-bus route overlay alongside the Gemini copilot.
The focused route appears while no copilot route or trip is selected; selected trip geometry takes priority so a full focused route cannot obscure boarding guidance.
Showcase focus uses captured fixture geometry through the validated pattern cache and makes no live pattern requests.
Both catalog reservations and prediction headroom count against the shared vehicle polling allowance, and actual upstream requests share the hard daily cap.
The earlier phone overlay check remains recorded in [transit verification](TRANSIT_ROUTES_VERIFICATION.md); it does not verify the newly combined copilot interface on hardware.

The merged tree passes 27 web tests, 36 bus-service tests and 16 voice-service tests.
Web production and Android shared-module compatibility builds pass.
Regression coverage checks matching focused-pattern and copilot results from the same RTS client, plus demo planning without upstream calls and fixture-based focused-route caching.

## Discovery and copilot presentation

This pass starts from the contributor's merged light redesign at `a959bd8` and keeps substantial presentation work isolated in `web/src/discovery.css` and `web/src/discovery.ts`.
Home adds a captured-route schematic, route selection, destination shortcuts and a typed entry point into the existing copilot pipeline.
The schematic marker is illustrative and never represents a live vehicle.
Trip cards show route and direction, boarding and drop-off stops, straight-line stop distance, ride stop count, and the existing truthful arrival labels.
The copilot exposes transcript, processing and error feedback, disables repeat prompt submission while thinking, and preserves typed input and destination clarification.
All dynamic transit text uses DOM text nodes.

All 32 web tests and the TypeScript/Vite production build pass.
New geometry tests cover all fixture routes and stops, geographic orientation, panel bounds and preserved Mercator aspect.
HTML nesting, unique control IDs and stylesheet parsing were also checked.
No backend or canvas HUD changes are included in this pass.
Visual browser and physical-device verification remain pending because the browser tool rejected access to the local preview URL under its URL security policy.

## Transit scope and model budget checkpoint, October 17, 2026

The default is Flash-Lite with one bounded Flash fallback on eligible failures, fresh tool state per attempt, minimal thinking, and a 2,048-token generation cap.
A separate 128-token scope classifier precedes all transit lookups and answer tools for keyed requests that are not already rejected locally.
The classifier has no image or tool access and fails closed; it is an additional request whose latency and token cost have not yet been measured against successful live provider calls.
Obvious coding, secret and mixed requests return a transit-only refusal locally without a provider call.
The scope rule is application behavior, not a restriction embedded in the Google key.
Process-local request admission limits traffic to 60 requests per minute and three simultaneous requests; public deployments need shared authenticated gateway limits and project quotas.

Before editing, the HTTP handler returned generic bus-data availability to a coding question instead of a scope refusal.
The voice server was not running, so reproduction and regression checks used FastAPI TestClient rather than the browser voice flow.
After the change, all 46 voice-service tests passed, including scope denial, mixed tasks, poisoned history, invalid classifier output, provider errors, action discard on fallback, safety refusal, valid map actions and HTTP 429 admission.
The live HTTP check refused the coding request with no actions; the trivia and map requests safely returned the scope-check-unavailable message because of the provider restriction described above.
Successful live Flash-Lite classification, model tool selection, fallback quality, visual sign reading, browser map rendering and real speech remain pending for this checkpoint.

The subsequent free-tier-only direction keeps API-key authentication and disables model fallback in code defaults, the environment example and local configuration.
The supplied key still requires a project marked Free tier in AI Studio; client settings cannot convert a billed key's usage to free usage.
Billing accounts were not changed, and no Vertex AI integration was added.

After the user supplied a new key, live Flash-Lite scope classification succeeded and Google subsequently reported the `generate_content_free_tier_requests` quota (limit 15).
Live checking exposed an unsupported `tool` role on function results; changing function-result content to the supported `user` role fixed the provider HTTP 400.
The regression test now checks the function-result role.
A live HTTP map request returned source `gemini` with a validated expanded-map action, and trivia and coding requests returned scope refusals with no actions.
The final focused-bus check reached HTTP 429 free-tier quota exhaustion and returned a local unavailable response, without model fallback.
All 48 voice-service tests passed after the role fix.
These checks verify the server HTTP response and action payload, not browser rendering, microphone behavior or grounded live RTS answers.

## Efficient voice workflow acceptance (pending)

The efficient voice workflow supersedes the scope-classifier/tool-loop and browser-only speech behavior recorded in earlier checkpoints.
Implementation was reviewed by code inspection only.
No tests, builds, Gemini text inference, TTS inference, live RTS checks or browser/hardware acceptance were run for this change, as instructed.
Earlier passing counts and provider evidence do not verify this workflow.
The existing text SDK and direct server-side API key remain; no billing, credential, OpenRouter or Vertex changes were made.
Google currently lists a free tier for [Flash-Lite TTS](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash-lite-tts), but the key's project must itself remain on Free tier.

The implementation has full-command local controls, one structured scope/intent request, deterministic transit templates, an optional second explanation call, two short history turns, separate provider budgets, approved speech identifiers, lazy WAV generation, bounded audio caching and cancellation-aware shared phone playback.
New or updated regression cases are authored but unrun.

Authorize and perform the following acceptance scenarios before claiming verification:

- Exact map commands use zero Gemini text calls, including during cooldown; mixed coding/transit requests apply no actions.
- Routine transit questions use one text call; explicit complex explanations use at most two, including budget admission for the second call, with no retries or model fallback.
- Ambiguous destinations require a stop choice; invalid routes, wrong direction, stale catalog/vehicle data and missing arrivals remain explicit.
- Trip selection re-queries current options and rejects invented or obsolete IDs; stop guidance is stationary and labels straight-line bearing/distance rather than a pedestrian path.
- Only issued, unexpired speech identifiers can synthesize; arbitrary text, malformed identifiers and extra fields are rejected.
- Speech identifiers expire after two minutes and remain bounded to 128 entries; exact-text/model/voice/style audio cache expires after 30 minutes and respects 128-entry/32-MB limits.
- Cache hits avoid TTS provider quota, concurrent identical misses share one generation, and canceling one listener preserves any remaining listeners.
- Text and TTS rolling budgets stay independent at 12 text calls and ten TTS generations per minute by default; provider HTTP 429 honors numeric and HTTP-date Retry-After without retries.
- TTS timeout, invalid WAV, provider error, blocked autoplay and stalled playback fall back to browser speech while recognition remains active for explicit wake detection.
- New questions, cancellation and leaving a session prevent late audio, stale action application, duplicate speech and old fallback utterances.
- Shared approved confirmations are spoken with the answer in one audio reply; failed validation or action application never starts remote speech.
- Typed input works without browser recognition; speech completion restores wake-only standby and a fresh wake phrase interrupts playback.
- Both Cardboard eyes and casting retain matching map state and subtitles, with one phone audio output and the minimap visible.
- Phone microphone, iPhone/Android gesture-based audio unlock, physical headset playback, outdoor alignment and cast-network behavior remain pending hardware checks.

When authorized, run the web and voice-service regression suites, the web production build, and the Android shared-module compatibility build using the commands above.
Then verify live structured text and the REST TTS adapter against the configured project's actual model access and quotas.
Browser speech recognition remains the speech-to-text provider; availability depends on the browser and may require a network connection.


## Explicit clarification state verification, 2026-10-17

Clarification metadata now carries an opaque, session-bound five-minute token, prompt, expected input type and expiry.
The server retains supported intent arguments and authoritative choice IDs in a bounded process-local store.
Map mode and zoom commands preserve pending input; completion, explicit replacement/cancellation and client session/data-mode changes clear it.
Unknown or expired tokens require the full request again, without transit actions.
Provider/transit failures retain the pending question.
Legacy clients can omit the new fields.

All 106 voice-service tests and 83 web tests pass, and the web production build passes.
Cross-service fixture tests cover multi-step route/stop completion, destination and vehicle choices, reordered candidate results, invalid input, outages, cancellation, expiration, session/mode isolation, server restart and request deduplication.
Client tests cover validation, failed action application, interrupted and out-of-order responses, reset and data-mode changes.
Live Gemini completed a free-form arrival question, a route answer and a stop answer using explicit tokens with empty chat history.
A separate live check applied a free-form map expansion while preserving the same pending token.
Desktop Chrome completed typed arrival question → Shands → zoom out → 38 and displayed the matching stop/vehicle result.
Physical iPhone microphone, repeated wake activation and audible interruption acceptance remain pending on the device.
Android verification is excluded at the user's request.
