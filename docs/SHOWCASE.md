# TransitLens showcase

## The story

A street full of buses is useful only if you can understand which one gets you where you need to go.
TransitLens combines the physical view, live transit data and a voice assistant into one interaction.
The demonstration should show one complete task, rather than a list of features.

## Prepare

Run `./scripts/dev.sh` and set the ignored service environment files.
Add the Gemini API key to `voice-service/.env` and restart before claiming a live Gemini demonstration.
For phone access, use an HTTPS origin and keep the three services running.
Choose Cardboard for the headset or Handheld for a full-screen phone view.
Enable casting and open `/cast.html` on the laptop when presenting to judges.
Check the actual phone, microphone, permissions and network beforehand.

Choose Live RTS for actual vehicles and current available route patterns/predictions.
Choose Showcase demo when consistent vehicle placement is needed.
The latter uses ten moving synthetic buses on captured RTS routes, with synthetic arrivals clearly labeled.
Gemini itself can operate on demo transit data once its key is configured.
Without the key, commands use an explicitly labeled deterministic interpreter rather than Gemini.

## A short demonstration

1. Look at a bus marker and hold your gaze.
Ask "Hey Gemini, where is this bus going?"
The bus card and spoken reply establish the spatial interaction.
2. Ask "Show routes to Shands."
Route geometry and actual boarding/alighting stops appear, with a clarification if the live destination name matches separate locations.
The demo fixture resolves Shands Hospital at Davis Cancer Pavilion via route 38 from Reitz Union.
3. Say "Take the first option."
The view highlights the trip segment, marks the stationary boarding stop, and displays approximate distance and bearing.
Available RTS predictions are distinct from the demo's explicitly scripted four-minute arrival.
4. Say "Close the map", then "Cancel guidance."
The shared state returns to compact exploration in both eyes and casting.
5. If the camera can see a readable destination display, ask "Read the bus sign."
This sends one small still to Gemini, rather than continuously uploading the camera feed.
It requires the Gemini key and a live camera; it cannot be demonstrated honestly with the camera-free desktop scene.

After each spoken reply, there is a short listening window for follow-ups without another wake phrase.
The voice control or Space key activates listening directly.
Typed questions and option cards provide an accessible fallback and help recover from a noisy room.

## Claims to keep precise

Route coverage comes from ordered RTS patterns, while active buses and arrival predictions are separate facts.
A visible route number does not prove a specific vehicle serves every stop on that route.
The boarding cue is straight-line direction and distance, not turn-by-turn pedestrian navigation.
Do not call scripted responses live Gemini or synthetic arrivals real RTS predictions.
The code and desktop checks do not certify headset alignment or phone speech behavior.
