// Browser SpeechRecognition, including Safari's webkit-prefixed implementation.
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
  let session = 0;

  const api: Recognizer = { start, stop, onResult: null, onError: null };

  function build(): SR {
    const r: SR = new Ctor();
    const id = ++session;
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      if (rec !== r || !wantRunning) return;
      // One event can finalize several phrases. Earlier unchanged results are
      // retained by the browser, so only process the changed range.
      const interim: string[] = [];
      let interimIndex = -1;
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          if (i >= e.resultIndex) api.onResult?.(result[0].transcript, true, `${id}:${i}`);
        }
        else { interim.push(result[0].transcript); if (interimIndex < 0) interimIndex = i; }
      }
      if (interim.length) api.onResult?.(interim.join(' '), false, `${id}:${interimIndex}`);
    };
    r.onerror = (e) => {
      if (rec !== r || !wantRunning) return;
      // 'no-speech' and 'aborted' are routine; onend will restart us.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantRunning = false;
        clearTimeout(restartTimer);
        document.removeEventListener('visibilitychange', onVisibility);
        api.onError?.('Microphone permission denied', true);
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        api.onError?.(`Speech recognition error: ${e.error}`, false);
      }
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
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
    if (!wantRunning || running || document.visibilityState === 'hidden') return;
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
    clearTimeout(restartTimer);
    wantRunning = true;
    document.addEventListener('visibilitychange', onVisibility);
    startNow();
  }

  function retire() {
    clearTimeout(restartTimer);
    const old = rec;
    rec = null;
    running = false;
    try {
      old?.abort();
    } catch {
      // ignore
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') retire();
    else startNow();
  }

  function stop() {
    wantRunning = false;
    document.removeEventListener('visibilitychange', onVisibility);
    retire();
  }

  return api;
}
