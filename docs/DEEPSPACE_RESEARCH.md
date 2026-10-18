# DeepSpace fit for TransitLens

Research date: October 17, 2026.
Status: evaluated from official documentation; no SDK installed, account created, credits claimed or application integration implemented.

## Recommendation

Consider DeepSpace for shared session data and an optional laptop companion.
Keep the existing AR renderer, authoritative RTS queries and Gemini integration.
The first experiment should demonstrate useful cross-device state sharing before choosing a wider migration.

DeepSpace provides SQLite-backed records synchronized through WebSockets and Durable Objects, including acknowledged mutations and reconnection snapshots.
That maps to a session's selected route, boarding stop, destination, map mode and range.
The current app already keeps those values in shared local state, while its cast relay has one process-wide offer slot.
A session-scoped service could support independent sessions without making the AR rendering loop depend on network latency.
This is an architectural recommendation, not a tested integration.
See [real-time sync](https://docs.deep.space/concepts/realtime-sync).

## Where it could help

| Area | Proposed use | Assessment |
| --- | --- | --- |
| Phone/laptop companion | Subscribe to one trip session and display selected route, stop, destination and map changes | Strongest fit |
| Connection status | Ephemeral presence for wearer and viewers | Useful alongside session sync |
| Saved destinations | Optional signed-in favorites and reusable trip requests | Good later addition |
| Cast pairing | Scoped offer/answer records with access checks and expiration | Worth a prototype; state sync alone does not transport video |
| Shared RTS cache | Publish validated snapshots from a trusted backend | Lower priority because bus-service already caches upstream data |
| Camera, stereo, compass and gaze | Keep computation and drawing on the phone | No benefit from moving these into the SDK |
| Gemini answers and TTS | Retain the current provider and typed action loop | No migration needed |

PresenceRoom stores transient peer state in memory; it is distinct from the slower persistent online heartbeat.
Use it for connection indicators, not saved trips or authoritative selections.
Do not publish sensor updates every frame.
See [presence](https://docs.deep.space/guides/presence-and-cursors).

Saved preferences could use optional authentication and owner-scoped records.
Keep the ordinary bus-identification experience available without account creation.
Collection permissions must be enforced on the server; merely hiding another session's UI or choosing an unpredictable room name is insufficient.
See [authentication](https://docs.deep.space/guides/authentication) and [permissions](https://docs.deep.space/concepts/permissions).

## Integration boundaries

The standard scaffold is Vite/React with a Hono Cloudflare Worker.
TransitLens uses plain TypeScript with separate FastAPI services, so this is not a direct deployment replacement for the whole repository.
A hybrid would leave the Python services hosted separately and add a small DeepSpace Worker for session data.
See [architecture](https://docs.deep.space/concepts/architecture).

The SDK documents a lower-level WebSocket vocabulary for custom clients, including `clientBuild`, `dispatch` and `encode`.
Prototype an isolated adapter or a small companion React surface before adopting it in the phone application.
Confirm bundle impact, authentication, room authorization and reconnection behavior against an exact SDK version.
No full frontend rewrite is justified by this research.
See [SDK reference](https://docs.deep.space/sdk-reference/overview).

The documented AI factory lists Anthropic, OpenAI and Cerebras.
It does not establish drop-in compatibility with our Gemini text/TTS path.
The external integration catalog must be inspected before assuming RTS, Google Maps or Gemini endpoints exist.
See [AI reference](https://docs.deep.space/sdk-reference/worker/ai) and [external APIs](https://docs.deep.space/guides/external-apis).

DeepSpace's LiveKit feature manages room lifecycle and tokens; media publishing still requires LiveKit's client SDK.
It is a separate optional casting migration, with permissions and billing to evaluate.
Do not treat record synchronization as a video relay.
See [LiveKit rooms](https://docs.deep.space/guides/livekit).

## Smallest useful experiment

1. Create an isolated companion session using a fixed public demo location.
2. Publish only validated selected-route, stop, destination and map state with session ID, revision, freshness and expiry.
3. Have a second device subscribe using the SDK and show updates after a phone voice command.
4. Demonstrate viewer presence, refresh/rejoin recovery and rejection of a different session's reader or writer.
5. Disconnect DeepSpace and confirm that camera, compass, local selection and existing transit tools continue working.

The phone remains the authority for its current UI state.
Use acknowledged writes for discrete selections and avoid replaying old remote state over newer local actions.
Do not send camera frames, raw microphone audio or precise location into session storage by default.
Any later shared-location feature should be explicit and temporary.

This would demonstrate real SDK data and realtime functionality, which appears aligned with the screenshot's requirement beyond hosting.
Only organizers can confirm prize eligibility.
The supplied screenshot says to use the referral before creating an account, and gives an October 28, 11:59 PM ET claim-and-use deadline.
Those promotion terms were not independently confirmed in public documentation.
Credit pricing and usage charges should be checked in the dashboard before adoption; see [billing terms](https://deep.space/terms).

DeepSpace currently documents Node 22.15+, 24 or 26 and excludes Node 25.
This laptop currently has Node 25.1; the prepared deployment containers use Node 24.
Use a supported Node line for any SDK experiment.
See [installation](https://docs.deep.space/get-started/installation).
