# Cardboard HUD and floating map

Cardboard has no Ask, microphone, map-toggle or zoom buttons.
Phone mode retains its touch controls and typed assistant.
The compass, gaze selection, compact minimap, attribution, calibration and long-press exit remain available.
Active voice work uses a passive status indicator and at most three wrapped subtitle lines.

Say “Hey Gemini, full size the map” to open the centered transparent map.
“Make the map bigger,” “show the full map” and “make the map full size” are equivalent.
These complete commands use local validated actions and make no Gemini inference request.
They change display mode without changing geographic range.
“Zoom in” and “zoom out” change range; “close the map” restores the compact minimap while preserving trip selection and guidance.

The expanded map is a nearly full-view, rounded glass panel in both Cardboard and Phone mode.
Cardboard uses approximately 4% horizontal and 5% vertical margins; Phone mode reserves room for the compass and respects safe-area insets.
It uses a faint tint, a bright rim and top highlight, with no background blur.
The street or radar base uses 30% opacity; transit overlays retain their normal opacity and marker emphasis.
Both layers use the same geographic projection and cover crop.

Opening scales from 0.92 to 1, fades in and rises over 350 ms.
Closing reverses over 220 ms before restoring the compact minimap.
Reversing an animation preserves its current progress, and reduced-motion preferences make opening and closing immediate.
The panel anchors to heading and pitch when opened.
Small turns hold that anchor; turns beyond 10 degrees of yaw or 8 degrees of pitch trigger critically damped following with a 250 ms time constant.
Following stops within approximately 2 degrees to avoid jitter.
Without heading, the panel stays centered in the view.

Panel motion is computed once per frame and shared by both eyes and casting.
The compass, gaze/status, summary and subtitles remain head-locked above the glass.
Voice replies do not change panel bounds.
Range, attribution and road-failure notices sit inside its edges.
Phone controls remain available as translucent buttons.
Missing location suppresses unpositioned transit overlays, and road failures retain an explicit radar notice.
Expanded guidance keeps the distinction between a stop bearing and a verified walking path visible.

The shared map buffer is rectangular, with a 512 CSS-pixel short side, at most a 2:1 aspect ratio and pixel ratio capped at 2.
Extent measures center-to-edge distance along the short side.
The compact minimap crops its center square; expanded and cast views use cover crops without stretching geography.
Only viewport geometry changes resize the buffer.

## Verification

Web tests cover animation timing and reversal, reduced motion, anchor deadzones, north wraparound, settling, missing heading, safe-area bounds, rectangular projection, center cropping, matching eye layers and animation opacity.
They also cover long replies, location and compass limitations, radar notices and validated map commands.
The web production build passes.
Desktop Chrome inspection covers matching stereo glass panels, Phone controls, typed map expansion and radar fallback.
Road tiles were unavailable during desktop inspection; live road appearance remains pending visual acceptance.
Android verification is excluded at the user's request.

Physical iPhone speech, camera transparency, headset reading comfort, outdoor readability, real sensor pitch and a fresh phone-to-laptop cast connection remain pending.
Desktop inspection and simulated canvas tests do not establish those device acceptance results.
