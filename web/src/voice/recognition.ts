// Wrapper around Chrome's SpeechRecognition (webkit-prefixed on Android Chrome).
// Handles the two things that make it painful: it stops itself after silence or
// on errors, and it has no proper TypeScript types.

import type { Recognizer } from './types';

/** Minimal shape of the browser API; lib.dom doesn't ship these types. */
type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SREvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

export function isSpeechRecognitionSupported(): boolean {
  const w = window as any;
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

export function createBrowserRecognizer(lang = 'en-US'): Recognizer {
  const w = window as any;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) throw new Error('SpeechRecognition not supported in this browser');

  let wantRunning = false;
  let running = false;
  let restartTimer = 0;
  let rec: SR | null = null;

  const api: Recognizer = { start, stop, onResult: null, onError: null };

  function build(): SR {
    const r: SR = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      // Only look at the newest result; earlier ones were already handled.
      const last = e.results[e.results.length - 1];
      if (!last) return;
      api.onResult?.(last[0].transcript, last.isFinal);
    };
    r.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; onend will restart us.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantRunning = false;
        api.onError?.('Microphone permission denied', true);
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        api.onError?.(`Speech recognition error: ${e.error}`, false);
      }
    };
    r.onend = () => {
      running = false;
      if (wantRunning) {
        // Chrome ends recognition after ~5-10s of silence; restart quickly.
        clearTimeout(restartTimer);
        restartTimer = window.setTimeout(startNow, 150);
      }
    };
    return r;
  }

  function startNow() {
    if (!wantRunning || running) return;
    try {
      rec ??= build();
      rec.start();
      running = true;
    } catch {
      // "already started" races: try again shortly.
      restartTimer = window.setTimeout(startNow, 300);
    }
  }

  function start() {
    wantRunning = true;
    startNow();
  }

  function stop() {
    wantRunning = false;
    clearTimeout(restartTimer);
    try {
      rec?.abort();
    } catch {
      // ignore
    }
    running = false;
  }

  return api;
}
