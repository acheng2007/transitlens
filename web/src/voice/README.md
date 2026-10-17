# Browser transit voice module

`startVoice` preserves the browser recognition, wake phrase, question capture, speech synthesis and lifecycle pipeline.
The web application supplies `requestAnswer` through `createTransitConversation` in `transit.ts`.
The active backend is the Gemini transit service on port 8002.

Enable the voice assistant on the start screen, hold your gaze on a bus route marker, then say "Hey Gemini, where is this bus going?"
Gaze context is frozen on wake activation so turning your head during the question does not silently change its target.
Questions are submitted after 1.3 seconds of silence, with an eight-second activation timeout and a fifteen-second question cap.
The browser pauses recognition while speaking and resumes afterward.
A newer typed question supersedes the old request, and leaving the view aborts pending work and clears conversation state.

`Ask Gemini` opens a typed-question panel with example prompts.
Typing works with the voice checkbox off, unsupported recognition, or denied microphone permission.
Replies still use available browser speech synthesis and the same stereo/casting subtitle state.
The minimap stays visible alongside subtitles.

`transit.ts` sends only bounded questions, history, focused/previous bus IDs, location, search radius and map state.
The server resolves vehicle facts, and the client validates the complete action batch and request ID before changing shared map state.
Only an explicit bus-sign reading question attaches a resized JPEG; normal transit commands do not attach images.
A seven-second follow-up capture window supports conversation without another wake phrase.
Source labels distinguish Gemini API, local transit tools and scripted demo responses.
Legacy `Plane` exports and optional context hooks remain for imported code compatibility; the active service requires the transit contract in `shared/assistant.ts`.
Optional remote audio helpers remain available, but the Gemini flow uses browser speech only.

## Deterministic development harness

With Vite running, open `/src/voice/dev.html`.
Select "Start (fake mic)" and type `Hey Gemini expand the map`, `Hey Gemini zoom in`, or `Hey Gemini where is this bus going`.
The checked SCRIPTED DEMO option uses clearly labeled synthetic responses without microphone, RTS or Gemini access.
Uncheck it and enter a current live bus ID to exercise the real transit endpoint around the fixed public Reitz Union development location.
Start (real mic) requires browser recognition support and microphone permission.

Recognition support and behavior vary by browser and may depend on a network speech service.
Real phone, headset and spoken-interaction verification remains pending.
Run `npm test` in `web` for wake matching, bounded context, response validation, stale/session guards and shared map state checks.
