# Frontend bug audit, October 17, 2026

This audit exercises the running frontend in the desktop browser using the fixed public Reitz Union position and a camera-free background.
Existing uncommitted work is preserved.
Physical camera, GPS, compass, microphone, headset alignment and phone-to-laptop casting require a separate device check.

## 1. Loading requests appear to be successful empty results

Severity: medium.

Reproduction:

1. Open `http://localhost:5173/?dev=1&camera=off&demo=1`.
2. Inspect the home screen while its first nearby-bus request is pending.
3. The status pill says `Live RTS` and the nearby section says `No nearby buses` before the request has answered.

Expected: show `Connecting` and `Loading live buses…` until an actual response establishes availability or an empty result.
Actual: pending requests are indistinguishable from a successful empty result.
This can incorrectly imply that there is no service while the app is still loading.

Root cause: the home renderer tests `/Live RTS|No nearby buses/` against the feed status.
The initial status, `Connecting to Live RTS`, matches that expression.

Fixed: added an explicit classifier for completed live, empty, unavailable and pending feed statuses.
A connecting status no longer matches a successful response.
Verified by reloading the browser and observing `Connecting` with `Loading live buses…`, followed by the real empty result after the response.
A regression test also covers GPS-prefixed statuses and cached-data age suffixes.

## 2. Settings allows keyboard activation of the covered home screen

Severity: medium.

Reproduction:

1. Click the Settings button on the home screen.
2. Press Tab once.
3. Keyboard focus moves to the covered `Enter AR` button rather than a Settings control.
4. Press Enter.
5. The AR view launches while the user was navigating Settings.

Expected: focus moves into Settings, stays inside while it is open, and returns to the opener on dismissal.
Actual: focus stays on the home-screen opener and can activate invisible background controls.
Screen readers also receive the covered home screen alongside Settings.

Root cause: Settings is an ordinary section overlaid on the home screen, without modal focus handling or background isolation.

Fixed: replaced the overlaid section with a native modal dialog and preserved its full-screen appearance.
The browser now isolates the background, focuses Done on opening, contains tab navigation and restores focus to the Settings opener.
Done and Escape both save settings through the same close handler.
Verified in the browser: the accessibility tree contains only Settings while open, Tab moves from Done to System, and Escape returns focus to the opener without launching AR.

## 3. Selecting a returned trip searches for a literal selected boarding stop

Severity: high for the typed demo journey flow.

Reproduction:

1. Open the camera-free desktop URL above and click `Explore the demo`.
2. Open `Ask`, then choose `Routes to Shands` with the local voice service running and no Gemini key.
3. The app correctly returns route 38 from Reitz Union to Shands Hospital at Davis Cancer Pavilion, with the demo arrival explicitly labeled scripted.
4. Click that returned trip card.
5. The assistant says `No direct trip to the selected boarding stop was found` and removes the valid trip choice.

Expected: select the returned journey and guide toward its stationary Reitz Union boarding stop.
Actual: the selection triggers a new destination search for `the selected boarding stop`, replacing the valid Shands plan with an empty result.

Root cause: the local command parser processes the general `guide me to <destination>` expression before the selected-trip expression.
The card's command is consumed by the destination branch before its authoritative selected journey ID can be resolved.

Before-fix evidence: [trip selection failure](qa/2026-10-17/trip-selection-before.png).

Fixed: selected-boarding-stop commands bypass the generic destination-search branch and resolve the selected journey ID against a fresh authoritative plan for the existing destination.
Verified in the running browser with the same Shands search and trip-card click: the app starts route 38 boarding guidance and retains the correct trip.
The map shows the boarding stop, destination and route overlay, with approximate bearing and scripted arrival labels.
Regression tests cover a selected second option and an expired option, which is rejected rather than replaced with a different trip.
After-fix evidence: [successful selection](qa/2026-10-17/trip-selection-after.png).

## 4. Expanded-map controls cover the reply and boarding instructions

Severity: medium.

Reproduction:

1. Search for Shands in the typed demo assistant, select its trip, and close the assistant panel.
2. In a near-square desktop viewport, the expanded-map control column crosses the assistant's transcript and reply.
3. At 390 by 844 pixels, the control row moves across the boarding-stop name instead.

Expected: map controls, route guidance, transcript, answer and minimap remain readable together.
Actual: opaque buttons cover the very instructions produced by selecting the trip.

Root cause: the expanded-control CSS positions controls around a large centered map, while the actual map shrinks and moves left whenever a journey or voice reply is active.
Its portrait rule moves the controls upward into the guidance panel.

Before-fix evidence: [phone layout](qa/2026-10-17/expanded-controls-before.png).

Fixed: expanded and compact modes now share the control row instead of placing expanded controls around an assumed centered map.
Portrait controls occupy the reserved strip below the map and above the feed-status label.
Verified visually at 390 by 844 pixels with a selected trip, active spoken reply, transcript and expanded minimap.
The controls no longer cover the boarding instructions or assistant reply.
After-fix evidence: [corrected portrait layout](qa/2026-10-17/expanded-controls-after.png).

## 5. Invalid route commands give unrelated bus-focus advice

Severity: medium.

Reproduction:

1. Open Ask in the camera-free demo, with the local voice service running without a Gemini key.
2. Submit `Highlight route 99999`.
3. The reply says Gemini is unavailable and asks the user to look at a bus marker.

Expected: explain that the requested route is absent from available RTS patterns and apply no map action.
Actual: the real route-validation error disappears and the fallback answer suggests a bus-focus problem.
The same error handling also hides unavailable selected trips and transit-network failures.

Root cause: the local-command endpoint catches transit query errors and silently falls through to focused-bus Q&A.

Fixed: introduced a dedicated user-facing transit-query error for known validation failures and return those messages without applying actions.
Unexpected transport or validation failures return a generic route-data-unavailable message without upstream details.
Verified in the browser: `Highlight route 99999` reports that the route is absent, and a subsequent Shands search and selection still work.
Endpoint regression tests cover unknown routes, transport failures and validation failures without leaking private error text.

## Verification and remaining device checks

All 31 web tests and 21 voice-service tests pass.
The production web build passes.
The build still reports existing bundle-size and Vite configuration warnings.
Voice tests report existing dependency deprecation warnings.

Browser checks covered initial loading, successful empty live results, launch/return/restart, Settings keyboard isolation and dismissal, demo route discovery, trip selection, stationary-stop guidance, cancellation, invalid-route recovery, camera-not-ready feedback and portrait layout.
Both Cardboard eyes share the same expanded/compact map state, and Escape first closes the map before returning home.
The desktop stereo check uses inherited calibration; it does not establish headset lens alignment or phone readability.
A missing voice service was also exercised before service startup; it produced a visible error while map controls and return navigation remained available.

Gemini cloud requests were not tested, because this audit deliberately runs the voice service with no Gemini key.
Browser speech recognition reported a network error in the desktop environment; real microphone, wake-phrase and spoken-output acceptance remain pending.
No camera or physical-location permission was requested for the desktop tests.
Physical phone camera, GPS, compass, outdoor bearing alignment, headset fit, real bus-sign reading and phone casting remain pending.
Android was not built because these fixes do not change its imported shared modules or native entry point.

The requested phone-test link requires the project's temporary Cloudflare HTTPS tunnel.
Automatic approval review rejected starting it because it would expose the local development server publicly through that provider.
The tunnel was not started; explicit approval for that specific exposure is needed before continuing the phone check.
