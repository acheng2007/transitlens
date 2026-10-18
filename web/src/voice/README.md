# Browser transit voice module

`startVoice` preserves the browser recognition, wake phrase, question capture, speech synthesis and lifecycle pipeline.
The web application supplies `requestAnswer` through `createTransitConversation` in `transit.ts`.
The active backend is the Gemini transit service on port 8002.

Enable the voice assistant on the start screen, hold your gaze on a bus route marker, then say "Hey Gemini, where is this bus going?"
Gaze context is frozen on wake activation so turning your head during the question does not silently change its target.
Questions are submitted after 1.3 seconds of silence, with an eight-second activation timeout and a fifteen-second question cap.
Recognition stays active for wake detection during thinking, synthesis and playback.
Each activation captures one question, then returns to wake-only standby.
A greeting plus Gemini is required; bare names do not activate capture.
A newer typed question supersedes the old request, and leaving the view aborts pending work and clears conversation state.

`Ask Gemini` opens a typed-question panel with example prompts.
Typing works with the voice checkbox off, unsupported recognition, or denied microphone permission.
Replies use approved Gemini WAV speech with browser speech fallback and the same stereo/casting subtitle state.
The minimap stays visible alongside subtitles.

`transit.ts` sends only bounded questions, history, focused/previous bus IDs, location, search radius and map state.
The server resolves vehicle facts, and the client validates the complete action batch and request ID before changing shared map state.
The conversation adapter also carries the server-issued clarification token for typed and spoken replies.
It accepts new clarification metadata only after validation, stale-response checks and successful action application.
Map commands and audio interruptions preserve the pending question; completed questions, explicit replacement/cancellation, session resets and data-mode changes clear it.
Choice buttons answer pending questions with their stable IDs, retaining the original intent.
Expired tokens and server restarts require repeating the full request.
Only an explicit bus-sign reading question attaches a resized JPEG; normal transit commands do not attach images.
Say "Hey Gemini" again for every spoken question, including clarification replies.
During an answer it cancels pending work and audio, then captures a new question, including words following the wake phrase.
Consumed wake activations are tracked within browser result IDs, so late interim/final updates cannot submit the same question twice.
A fresh wake appended to the same long-lived interim result can still interrupt playback or a pending answer and start a new question.
When a result contains repeated activations, only the question after the latest activation is captured.
Source labels distinguish Gemini API, local transit tools and scripted demo responses.
The active voice service requires the transit contract in `shared/assistant.ts`.
`conversation.ask()` preserves the legacy string interface; `conversation.askSpeech()` returns answer text, an optional approved speech identifier, and a client-confirmed action result.
The shared voice flow requests `/api/voice/tts` only after response validation and action application.
The service accepts an issued identifier rather than arbitrary text.
Normal answers, clarifications and successful action confirmations use approved Gemini speech when a key and quota are available.
Shared confirmation templates and an approved `speechText` avoid an abrupt device-voice suffix after Gemini audio.
Validation or application failures cannot start success audio.
Service errors, refusals and unavailable audio use browser speech.
Remote synthesis/download/playback startup has a twelve-second deadline; unavailable or invalid audio falls back without retrying.
New questions, `cancel()` and `stop()` abort remote work, settle playback and prevent late fallback speech.
The typed `onSpeechStatus` callback distinguishes preparation, actual playback, fallback reasons, unavailable device speech and cancellation.
The HUD and assistant source show "Gemini voice" or "Device voice", separately from text-answer provenance.
Current spoken-output fragments are ignored as speaker feedback; approved text replaces activation phrases so the phone does not wake itself.
One audio element is unlocked by the Start gesture, so Cardboard plays once through the phone.

## Deterministic development harness

With Vite running, open `/src/voice/dev.html`.
Select "Start (fake mic)" and type `Hey Gemini expand the map`, `Hey Gemini zoom in`, or `Hey Gemini where is this bus going`.
The checked SCRIPTED DEMO option uses clearly labeled synthetic responses without microphone, RTS or Gemini access.
Uncheck it and enter a current live bus ID to exercise the real transit endpoint around the fixed public Reitz Union development location.
Start (real mic) requires browser recognition support and microphone permission.

Recognition support and behavior vary by browser and may depend on a network speech service.
Real phone, headset and spoken-interaction verification remains pending.
Run `npm test` in `web` for wake matching, bounded context, response validation, stale/session guards and shared map state checks.
