# Live RTS Cardboard verification

## Scope and status

This file records the earlier live-feed checkpoint.
See [street-map verification](STREET_MAP_VERIFICATION.md) for the subsequent map and compass-filter milestone.

This checkpoint implements the user's live-first plan in the inherited Vite/TypeScript and FastAPI architecture.
Gemini, synthetic bus demo modes, route maps, arrivals, navigation, Mobile AR, and native Android bus migration remain deferred.
Implementation, desktop verification, and the live RTS credential check are complete.
Physical-device acceptance remains pending.

## Completed checks

- On October 16, 2026, the real RTS key retrieved a catalog of 27 routes.
The complete live snapshot returned 22 buses within 5 km of the fixed Reitz Union location, across 18 routes, through the actual Vite proxy.
Chrome displayed real bus markers, a focused route 13 card for Cottage Grove/UF Health, reported delay/speed/occupancy, and the minimap in both eyes.
Counts vary as vehicles move and service changes.
The live test exposed and fixed the plural `routes` catalog key and the singular `No data found for parameter` message used for inactive routes alongside active vehicles.
Both observed response forms now have endpoint regression tests.

- The unchanged aircraft fixture started in Firefox with voice disabled and camera blocked, displaying matching compass and minimap views.
The unchanged production build passed.
No physical phone or Cardboard headset was available for the baseline.
- The migrated web production build passes.
Eight web tests pass for dwell selection, wraparound, transit formatting, projection direction, Safari portrait and both landscape matrices, denied motion permission, one declination correction, aborted polling, ignored late responses, and the casting exit race.
- Ten backend tests pass for route batches, concurrent callers sharing one refresh, hourly route caching, duplicate vehicles, invalid positions, nullable metadata, mph preservation, empty results, auth failures, timeouts, incomplete batch failures, stale-cache retention, recovery, radius/FOV boundaries, and endpoint validation.
- Chrome desktop shows matching bus markers and focused transit cards in both eyes using a temporary mock upstream labeled `MOCK TEST - NOT LIVE`.
The test exercised the actual bus-service endpoint, Vite proxy, browser polling, projection, dwell, card drawing, and minimap pipeline.
The temporary mock server is separate from product data and is not a shipped demo fallback.
- Keyboard heading changes update the compass and markers.
The radar uses sub-kilometer ranges for nearby buses and remains visible on successful empty responses.
- A local WebRTC viewer received the shared route 38 card, minimap, and stale-data warning.
A single-browser test initially had a black viewer while the publisher tab was backgrounded; foregrounding the publisher produced the expected cast frame.
Physical phone-to-laptop/network testing remains pending.
- An iframe denying fullscreen, camera, geolocation, accelerometer, gyroscope, and magnetometer still starts with a labeled blank background and GPS/compass messages.
Double-clicking its center unlocks calibration and shows the zoom control in both eyes, despite fullscreen being unavailable.
Escape returns to settings, and Start successfully restarts the denied-permission session.
The temporary permission harness was removed after testing.
- The start form scrolls at a 400% desktop zoom, approximating a narrow viewport.
Browser zoom was restored after testing.
This does not substitute for physical Safari viewport testing.
- The Android TypeScript/Vite compatibility build passes with its inherited aircraft entry point.
`npm run apk` built and synced web assets, then stopped because JDK 21+ is unavailable.
No APK or native hardware behavior is claimed.
- `.env` is excluded by Git and the local key file has mode 0600.
The browser contract contains no key, and the browser source does not import the server environment.
HTTP client request logging is suppressed because upstream URLs contain credentials.
The final browser bundle is checked for server secret variable names.

## Reproduced fixes and scoped quality changes

The old fullscreen tap handler returned before calibration whenever a browser lacked fullscreen.
Calibration now continues whether fullscreen is unavailable, denied, or exited.
Gainesville's documented `No data found for parameter(s)` response initially produced an unavailable result through the API in a regression test.
It now yields a successful empty vehicle result without masking authentication or other upstream errors.
An async casting-offer test reproduced a peer connection being created after exit.
The publisher now aborts pending signaling requests and ignores late offers and answers.
The cast page and recording filename use TransitLens branding.
The start form scrolls and no longer gives checkboxes the inherited text-input minimum width.

The web dependency audit reported a source-map-js issue; a compatible update removed the web advisory.
The imported Android asset tooling has additional dependency advisories whose fixes require upstream dependency changes or incompatible updates.
Those broader native toolchain changes are deferred; this checkpoint does not claim an advisory-free Android toolchain.

## Provider and heading references

The [Gainesville-hosted BusTime v3 developer guide](https://riderts.app/bustime/apidoc/docs/DeveloperAPIGuide3_0.pdf) was downloaded and inspected during implementation.
It documents mph, WGS84 positions, ten-route requests, empty-result messages, and a default limit of 10,000 requests per key per day.
The bus service increases its configured snapshot interval when the route-batch count requires it to remain within that allowance.
A single service worker shares one cache; a multi-worker deployment would require a shared external cache and rate budget.

[Apple documents webkitCompassHeading as magnetic north](https://developer.apple.com/documentation/webkitjs/deviceorientationevent/1804777-webkitcompassheading).
The Safari path anchors the full rear-camera Euler matrix with that compass reference and retains vector smoothing.
Android retains its absolute quaternion/event path.
The bus flow obtains one location/date declination from [WMM2025](https://www.ncei.noaa.gov/products/world-magnetic-model), rather than substituting a fixed Gainesville constant or reusing Atlanta's correction.
If the service or model correction is unavailable, the compass remains usable with an explicit magnetic-heading limitation.
Model correction is separate from real device calibration and does not establish observed outdoor accuracy.

## HTTPS phone-test preparation

A user-approved temporary Cloudflare Quick Tunnel was started on October 16, 2026.
The public HTTPS origin returned the TransitLens page and an available live bus response with 20 nearby vehicles during verification.
Direct requests for the server `.env` file returned HTTP 403 without disclosing the key.
Vite allows the `trycloudflare.com` suffix alongside its existing ngrok host allowlist.
The tunnel client is temporary and no system service was installed.
The test link remains usable only while the tunnel, web server, and bus service are running.

Begin the phone test in Safari while stationary and handheld.
Tap Start, grant camera/motion/location, rotate to landscape, and check the two matching camera views, heading changes, bus markers, minimap, and dwell card.
Then check center double-tap calibration and long-press exit/restart before inserting the phone in Cardboard.
Record phone model, OS/browser version, permission results, and any observed alignment errors before marking physical support complete.

## Pending acceptance gates

1. On an actual iPhone over HTTPS, verify direct-gesture motion permission, denial/retry, camera selection, GPS accuracy, compass alignment, smoothing, both landscape directions, browser toolbar resize, and device-specific size/FOV calibration.
2. On Android Chrome and the target headset, verify geographic alignment, stereo fusion, camera crop, zoom, tilt, spacing, shift, lens size, outdoor readability, and stationary gaze selection.
3. Verify long-press exit, repeated start/stop, background/foreground, camera tracks, location watches, sensor listeners, wake locks, polling, and casting on physical devices.
Desktop lifecycle tests cover only the exercised browser/test paths.
4. Install a compatible JDK/Android SDK and build the APK if native packaging is needed.
The native app continues to track aircraft until a separately authorized migration.
5. Test casting between a visible phone publisher and a laptop on the intended network.
The inherited signaling relay is for development and does not provide multi-session production hosting.

The live Cardboard and iPhone acceptance gates remain open until the relevant real-service and physical-device checks actually pass.
