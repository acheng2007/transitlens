# iPhone compatibility checkpoint

## Changes

The browser recognizer now forwards every changed final phrase in a speech event, preserving a batched wake phrase and question.
Retired recognition instances cannot deliver results or restart over a new instance.
Recognition pauses while the page is hidden and creates a fresh instance when it becomes visible.
Hiding the page cancels an incomplete question or pending reply.
Returning to the active view attempts to resume paused inline camera video and reacquire the screen wake lock.
If playback cannot resume, the HUD explains how to restart the view.

The typed assistant follows visual viewport height and vertical offset, including keyboard resize and pan events.
Its content scrolls inside the remaining visible area.
The input retains a 16px font and text selection is enabled for Safari.
Unsupported recognition points to typed Ask rather than recommending Android.

The viewport integration follows WebKit's [Visual Viewport guidance](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/).
Browser recognition remains subject to Safari and device configuration, as described in [WebKit's speech recognition announcement](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/).

## Verification

Before editing recognition, a browser-event harness reproduced the loss of both the wake phrase and the first part of a batched question.
The regression now passes and additionally checks late results, tab hiding, fresh recognition on return and cleanup on stop.
A viewport regression checks keyboard shrink, vertical pan, restoration and event cleanup.
All 41 web tests pass.
The web production build and Android shared-module web build pass.
Desktop Safari successfully starts the camera-free phone view and renders the modal assistant.

Physical iPhone verification remains pending.
iPhone Mirroring reported that the phone was in use and disconnected during this checkpoint.
Desktop Safari and event harnesses do not verify physical microphone recognition, software keyboard placement, camera recovery or sensor permissions.

## Phone acceptance

Open the existing HTTPS phone link in Safari and reload before testing.
Check Phone mode in portrait and both landscape orientations, including the notch and home indicator.
Open Ask, enter a destination, submit, scroll the answer and close the keyboard.
Confirm that the field, submit button and Close control remain reachable.
Test a complete spoken wake phrase and question, then a follow-up after playback.
Switch tabs or lock the phone during a partial question, return and ask a new question.
Confirm the partial question was canceled and camera, compass, map and recognition recover.
Repeat with camera, motion or microphone denied and verify that the available fallback remains usable.
Check Cardboard stereo alignment and laptop casting separately on the actual devices.
