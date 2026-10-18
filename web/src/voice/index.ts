// Transit voice lifecycle. Start from a user gesture to unlock audio.

import { scanWake, normalizeTranscript } from './wake';
import { createBrowserRecognizer, isSpeechRecognitionSupported } from './recognition';
import { speak, speakRemote, stopSpeaking, unlockSpeech } from './tts';
import type { Recognizer, StartVoiceOptions, VoiceHandle, VoiceState, SpeechResult, SpeechStatus } from './types';

export type { Recognizer, StartVoiceOptions, VoiceHandle, VoiceState, SpeechResult, SpeechStatus } from './types';
export { matchWake } from './wake';
export { isSpeechRecognitionSupported } from './recognition';

const OFFLINE_ANSWER = "Sorry, I can't reach the voice service right now.";

export function startVoice(opts: StartVoiceOptions): VoiceHandle {
  const lang = opts.lang ?? 'en-US';
  const questionTimeoutMs = opts.questionTimeoutMs ?? 8000;
  const shouldSpeak = opts.speak ?? true;
  const ttsEndpoint = opts.ttsEndpoint ?? null;

  const silenceMs = opts.endOfQuestionSilenceMs ?? 1300;
  const maxQuestionMs = opts.maxQuestionMs ?? 15000;

  let state: VoiceState = 'idle';
  let stopped = false;
  let recognizer: Recognizer | null = null;
  let request: AbortController | null = null;
  let generation = 0;
  let recognitionFailed = false;
  let spokenText = '';
  // Safari may append a later wake to the same interim result index.
  // Retire consumed activations, while allowing a genuinely new wake in that result.
  const retiredUtterances = new Map<string, number>();
  const captureUtterances = new Map<string, number>();
  let pendingWakeFinal: string | null = null;

  function speechStatus(status: SpeechStatus) { opts.onSpeechStatus?.(status); }

  function interrupt() {
    const wasSpeaking = state === 'speaking';
    generation++;
    request?.abort();
    endCapture();
    stopSpeaking();
    spokenText = '';
    if (wasSpeaking) speechStatus({ state: 'cancelled', provider: null });
  }

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

  function onResult(text: string, isFinal: boolean, utteranceId?: string) {
    if (stopped || recognitionFailed) return;
    const normalized = normalizeTranscript(text);
    // Speaker feedback is never a new question. Exact fragments of current output are ignored.
    if (state === 'speaking' && normalized.split(' ').length >= 2 && spokenText.includes(normalized)) return;
    const wake = scanWake(text);
    const afterWake = wake?.question ?? null;
    const count = wake?.count ?? 0;
    const retired = utteranceId ? retiredUtterances.get(utteranceId) : undefined;
    if (retired !== undefined && count <= retired) return;
    // Adapters without result IDs can still deliver a late final for a consumed interim wake.
    if (!utteranceId && !capturing && isFinal && pendingWakeFinal === normalized) {
      pendingWakeFinal = null;
      return;
    }
    if (!capturing || afterWake !== null && utteranceId && count > (captureUtterances.get(utteranceId) ?? 0)) {
      if (afterWake === null) return;
      interrupt();
      beginCapture();
    }
    if (utteranceId) {
      retiredUtterances.delete(utteranceId);
      captureUtterances.set(utteranceId, count);
    }
    if (afterWake !== null) pendingWakeFinal = isFinal ? null : normalized;

    const phrase = (afterWake ?? text).trim();
    if (isFinal) {
      if (phrase) committed.push(phrase);
      interim = '';
      if (utteranceId) retireUtterance(utteranceId, count);
    } else {
      interim = phrase;
    }
    opts.onPartialTranscript?.(currentQuestion());
    if (currentQuestion()) {
      clearTimeout(questionTimer);
      clearTimeout(silenceTimer);
      silenceTimer = window.setTimeout(finishCapture, silenceMs);
    }
  }

  function retireUtterance(id: string, count: number) {
    retiredUtterances.set(id, count);
    if (retiredUtterances.size > 64) retiredUtterances.delete(retiredUtterances.keys().next().value!);
  }

  function currentQuestion(): string {
    return [...committed, interim].join(' ').replace(/\s+/g, ' ').trim();
  }

  function beginCapture() {
    opts.onCaptureStart?.();
    capturing = true;
    committed = [];
    interim = '';
    setState('listening');
    clearTimeout(questionTimer);
    clearTimeout(silenceTimer);
    clearTimeout(maxTimer);
    // "Hey Gemini" and then nothing: give up quietly.
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
    for (const [id, count] of captureUtterances) retireUtterance(id, count);
    captureUtterances.clear();
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
    question = question.trim().slice(0, 1000);
    if (stopped || !question) return;
    interrupt();
    const current = generation;
    opts.onTranscript?.(question);
    setState('thinking');

    const result = await fetchAnswer(question);
    if (stopped || current !== generation) return;
    const output: SpeechResult = typeof result === 'string' ? { answer: result } : result;
    const answer = output.answer;
    opts.onAnswer(answer);

    if (shouldSpeak) {
      setState('speaking');
      const text = output.speechText ?? answer;
      spokenText = normalizeTranscript(text);
      const report = (status: SpeechStatus) => {
        if (!stopped && current === generation) speechStatus(status);
      };
      const spokenRemotely = ttsEndpoint && output.speechId
        ? await speakRemote(output.speechId, ttsEndpoint, request?.signal, report) : false;
      if (stopped || current !== generation) return;
      if (!spokenRemotely) {
        if (!ttsEndpoint || !output.speechId) report({ state: 'fallback', provider: 'browser', reason: 'not_configured' });
        await speak(text, lang, report);
      }
      if (stopped || current !== generation) return;
      spokenText = '';
    }
    setState('idle');
  }

  async function fetchAnswer(question: string): Promise<string | SpeechResult> {
    const ctrl = new AbortController();
    request = ctrl;
    const t = window.setTimeout(() => ctrl.abort(), 35000);
    try {
      if (opts.requestAnswer) return await opts.requestAnswer(question, ctrl.signal);
      throw new Error('Transit conversation adapter is unavailable');
    } catch (e) {
      if (request === ctrl && !stopped && !ctrl.signal.aborted) opts.onError?.(`Voice service unavailable: ${(e as Error).message}`);
      return OFFLINE_ANSWER;
    } finally {
      clearTimeout(t);
    }
  }

  // ---- Start ---------------------------------------------------------------

  unlockSpeech();

  if (opts.recognizer) {
    recognizer = opts.recognizer;
  } else if (opts.listenForWake === false) {
    // Typed questions remain available without requesting microphone access.
  } else if (isSpeechRecognitionSupported()) {
    recognizer = createBrowserRecognizer(lang);
  } else {
    opts.onError?.('Speech recognition not supported in this browser. Use Ask to type a question.');
  }

  if (recognizer) {
    recognizer.onResult = onResult;
    recognizer.onError = (message, fatal) => {
      opts.onError?.(message);
      if (fatal) {
        recognitionFailed = true;
        endCapture();
        if (state === 'listening') setState('idle');
      }
    };
    recognizer.start();
  }

  return {
    stop() {
      stopped = true;
      interrupt();
      recognizer?.stop();
      setState('idle');
    },
    cancel() {
      interrupt();
      setState('idle');
      if (!stopped && !recognitionFailed) recognizer?.start();
    },
    ask,
    listen() {
      if (recognitionFailed || !recognizer) { opts.onError?.('Use Ask to type a question; microphone recognition is unavailable'); return; }
      if (!stopped) { interrupt(); beginCapture(); }
    },
    getState: () => state,
  };
}
