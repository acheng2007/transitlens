// Browser voice module (owner: Allison). See root CLAUDE.md for the contract.
//
//   const voice = startVoice({ getCurrentPlane, getNearbyPlanes, onStateChange, onAnswer });
//   ...
//   voice.stop();
//
// Call startVoice() from inside the Start tap handler: mic + speech playback
// both need a user gesture on Android Chrome.

import { matchWake } from './wake';
import { createBrowserRecognizer, isSpeechRecognitionSupported } from './recognition';
import { speak, speakRemote, stopSpeaking, unlockSpeech } from './tts';
import type { Plane, Recognizer, StartVoiceOptions, VoiceHandle, VoiceState } from './types';

export type { Plane, Recognizer, StartVoiceOptions, VoiceHandle, VoiceState } from './types';
export { matchWake } from './wake';
export { isSpeechRecognitionSupported } from './recognition';

const OFFLINE_ANSWER = "Sorry, I can't reach the voice service right now.";

export function startVoice(opts: StartVoiceOptions): VoiceHandle {
  const endpoint = opts.endpoint ?? '/api/voice/ask';
  const lang = opts.lang ?? 'en-US';
  const questionTimeoutMs = opts.questionTimeoutMs ?? 8000;
  const shouldSpeak = opts.speak ?? true;
  const ttsEndpoint = opts.ttsEndpoint === undefined ? '/api/voice/speak' : opts.ttsEndpoint;

  const silenceMs = opts.endOfQuestionSilenceMs ?? 1300;
  const maxQuestionMs = opts.maxQuestionMs ?? 15000;

  let state: VoiceState = 'idle';
  let stopped = false;
  let recognizer: Recognizer | null = null;

  // Question capture. Chrome marks a phrase "final" at any short pause, so asking on the first
  // final result cut people off mid-sentence. Instead, after the wake phrase we collect every
  // phrase (final + the current interim one) and only ask once the user has been quiet for
  // `silenceMs`. Any new speech, interim included, pushes that deadline back.
  let capturing = false;
  let committed: string[] = [];
  let interim = '';
  let questionTimer = 0; // nothing said yet after the wake phrase -> give up after questionTimeoutMs
  let silenceTimer = 0; // user went quiet -> ask
  let maxTimer = 0; // hard cap on one question's length

  function setState(s: VoiceState) {
    if (state === s) return;
    state = s;
    opts.onStateChange(s);
  }

  // ---- Wake phrase / question handling ------------------------------------

  function onResult(text: string, isFinal: boolean) {
    if (stopped || state === 'thinking' || state === 'speaking') return;

    if (!capturing) {
      const afterWake = matchWake(text);
      if (afterWake === null) return;
      // Wake phrase heard (interim is enough, for fast feedback). Start collecting the question.
      beginCapture();
    }

    // The phrase containing the wake word keeps arriving with "hey grok" at the front; strip it.
    const phrase = (matchWake(text) ?? text).trim();
    if (isFinal) {
      if (phrase) committed.push(phrase);
      interim = '';
    } else {
      interim = phrase;
    }
    if (currentQuestion()) {
      // They've started talking: the "nothing said" timeout no longer applies.
      clearTimeout(questionTimer);
      clearTimeout(silenceTimer);
      silenceTimer = window.setTimeout(finishCapture, silenceMs);
    }
  }

  function currentQuestion(): string {
    return [...committed, interim].join(' ').replace(/\s+/g, ' ').trim();
  }

  function beginCapture() {
    capturing = true;
    committed = [];
    interim = '';
    setState('listening');
    clearTimeout(questionTimer);
    clearTimeout(silenceTimer);
    clearTimeout(maxTimer);
    // "hey grok" and then nothing: give up quietly.
    questionTimer = window.setTimeout(() => {
      if (!currentQuestion()) {
        endCapture();
        if (state === 'listening') setState('idle');
      }
    }, questionTimeoutMs);
    // Someone rambling (or background chatter): ask with what we have.
    maxTimer = window.setTimeout(finishCapture, maxQuestionMs);
  }

  function endCapture() {
    capturing = false;
    committed = [];
    interim = '';
    clearTimeout(questionTimer);
    clearTimeout(silenceTimer);
    clearTimeout(maxTimer);
  }

  function finishCapture() {
    if (!capturing) return;
    const q = currentQuestion();
    endCapture();
    if (q) void ask(q);
    else if (state === 'listening') setState('idle');
  }

  // ---- Ask the service and speak the answer --------------------------------

  async function ask(question: string): Promise<void> {
    if (stopped) return;
    endCapture();
    opts.onTranscript?.(question);
    setState('thinking');

    const answer = await fetchAnswer(question, opts.getCurrentPlane(), opts.getNearbyPlanes());
    if (stopped) return;
    opts.onAnswer(answer);

    if (shouldSpeak) {
      setState('speaking');
      // Don't let the mic hear the phone talking to itself.
      recognizer?.stop();
      const spokenByGrok = ttsEndpoint ? await speakRemote(answer, ttsEndpoint) : false;
      if (!spokenByGrok && !stopped) await speak(answer, lang);
      if (stopped) return;
      recognizer?.start();
    }
    setState('idle');
  }

  async function fetchAnswer(question: string, plane: Plane | null, nearbyPlanes: Plane[]): Promise<string> {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, plane, nearbyPlanes }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`voice service returned ${res.status}`);
      const data = (await res.json()) as { answer?: string };
      if (!data.answer) throw new Error('empty answer');
      return data.answer;
    } catch (e) {
      opts.onError?.(`Voice service unavailable: ${(e as Error).message}`);
      return OFFLINE_ANSWER;
    } finally {
      clearTimeout(t);
    }
  }

  // ---- Start ---------------------------------------------------------------

  unlockSpeech();

  if (opts.recognizer) {
    recognizer = opts.recognizer;
  } else if (isSpeechRecognitionSupported()) {
    recognizer = createBrowserRecognizer(lang);
  } else {
    opts.onError?.('Speech recognition not supported in this browser (use Android Chrome)');
  }

  if (recognizer) {
    recognizer.onResult = onResult;
    recognizer.onError = (message, fatal) => {
      opts.onError?.(message);
      if (fatal) setState('idle');
    };
    recognizer.start();
  }

  return {
    stop() {
      stopped = true;
      endCapture();
      recognizer?.stop();
      stopSpeaking();
      setState('idle');
    },
    ask,
    listen() {
      if (!stopped && state === 'idle') beginCapture();
    },
    getState: () => state,
  };
}
