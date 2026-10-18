import type { SpeechFallbackReason, SpeechStatus } from './types';

// One phone audio output shared by Cardboard, handheld, and casting state.
export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// One <audio> element, created and "unlocked" inside the Start tap, reused for every answer.
// Android Chrome only allows play() without a gesture on an element that already played once.
let audioEl: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let cancelRemote: (() => void) | null = null;
let finishSpeech: (() => void) | null = null;
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

export function selectSpeechVoice(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const language = lang.replace(/_/g, '-').toLowerCase();
  const base = language.split('-')[0];
  const matching = voices.filter(v => v.lang.replace(/_/g, '-').toLowerCase().split('-')[0] === base);
  if (!matching.length) return voices.find(v => v.default) ?? voices[0];
  const quality = (v: SpeechSynthesisVoice) => {
    const name = v.name;
    const tier = /premium/i.test(name) ? 100 : /enhanced/i.test(name) ? 80
      : /natural|neural/i.test(name) ? 70 : /siri/i.test(name) ? 60 : /google/i.test(name) ? 40 : 0;
    const novelty = /\b(?:albert|bad news|bahh|bells|boing|bubbles|cellos|good news|hysterical|jester|organ|trinoids|whisper|wobble|zarvox)\b/i.test(name);
    return tier + (v.lang.replace(/_/g, '-').toLowerCase() === language ? 20 : 0)
      + (v.default ? 5 : 0) - (/compact/i.test(name) ? 50 : 0) - (novelty ? 200 : 0);
  };
  return [...matching].sort((a, b) => quality(b) - quality(a))[0];
}

/**
 * Must be called from a user gesture (the Start tap) so Android Chrome lets us
 * speak later without one. Speaks an empty utterance.
 */
export function unlockSpeech(): void {
  if (typeof Audio !== 'undefined' && !audioEl) {
    try {
      audioEl = new Audio(SILENT_WAV);
      audioEl.preload = 'auto';
      void audioEl.play().catch(() => {
        // Not in a gesture (dev page, tests); remote playback may then be blocked until one happens.
      });
    } catch {
      audioEl = null;
    }
  }
  if (!isSpeechSynthesisSupported()) return;
  try {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    speechSynthesis.getVoices(); // triggers async voice loading on Chrome
  } catch {
    // ignore
  }
}

/** Only an issued speech identifier may request remote audio. Cancellation settles playback too. */
export async function speakRemote(speechId: string, endpoint: string, signal?: AbortSignal, onStatus?: (status: SpeechStatus) => void): Promise<boolean> {
  cancelRemote?.();
  if (signal?.aborted) return false;
  if (!audioEl) { onStatus?.({ state: 'fallback', provider: 'browser', reason: 'unavailable' }); return false; }
  onStatus?.({ state: 'preparing', provider: 'gemini' });
  const el = audioEl;
  const ctrl = new AbortController();
  let finishPlayback: ((ok: boolean) => void) | null = null;
  let url: string | null = null;
  let playbackTimer = 0;
  let reason: SpeechFallbackReason | 'cancelled' | 'played' = 'unavailable';
  const cancel = () => {
    if (reason === 'unavailable') reason = 'cancelled';
    ctrl.abort();
    // An old completion must never stop a newer operation on the shared element.
    if (cancelRemote === cancel) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    finishPlayback?.(false);
  };
  cancelRemote = cancel;
  const onAbort = () => { reason = 'cancelled'; cancel(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  // This deadline covers synthesis, download and starting playback, not the spoken duration.
  const deadline = window.setTimeout(() => { reason = 'timeout'; cancel(); }, 12000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speechId }), signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = res.headers.get('x-speech-fallback');
      reason = res.status === 429 || detail === 'quota' ? 'quota'
        : detail === 'timeout' ? 'timeout' : detail === 'invalid_audio' ? 'invalid_audio' : 'service';
      return false;
    }
    if (!res.headers.get('content-type')?.toLowerCase().startsWith('audio/wav')) { reason = 'invalid_audio'; return false; }
    const blob = await res.blob();
    if (ctrl.signal.aborted || signal?.aborted || cancelRemote !== cancel) return false;
    if (blob.size < 44 || blob.size > 32 * 1024 * 1024) { reason = 'invalid_audio'; return false; }
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...header.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...header.slice(8, 12)) !== 'WAVE') {
      reason = 'invalid_audio'; return false;
    }
    if (ctrl.signal.aborted || signal?.aborted || cancelRemote !== cancel) return false;
    url = URL.createObjectURL(blob);
    currentUrl = url;
    el.src = url;
    const played = await new Promise<boolean>(resolve => {
      let settled = false;
      finishPlayback = ok => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      el.onended = () => finishPlayback?.(true);
      el.onerror = () => { reason = 'playback'; finishPlayback?.(false); };
      // A stalled media element must also return control to browser speech.
      playbackTimer = window.setTimeout(() => { reason = 'playback_timeout'; cancel(); }, 185000);
      void el.play().then(() => {
        if (ctrl.signal.aborted || signal?.aborted || cancelRemote !== cancel) { finishPlayback?.(false); return; }
        clearTimeout(deadline);
        onStatus?.({ state: 'playing', provider: 'gemini' });
        if (Number.isFinite(el.duration) && el.duration > 0) {
          clearTimeout(playbackTimer);
          playbackTimer = window.setTimeout(() => { reason = 'playback_timeout'; cancel(); }, (el.duration + 5) * 1000);
        }
      }).catch(() => { reason = 'playback'; finishPlayback?.(false); });
    });
    if (played) { reason = 'played'; return true; }
    return false;
  } catch {
    if (reason === 'unavailable') reason = 'network';
    return false;
  } finally {
    ctrl.abort();
    clearTimeout(deadline);
    clearTimeout(playbackTimer);
    signal?.removeEventListener('abort', onAbort);
    if (cancelRemote === cancel) {
      cancelRemote = null;
      el.onended = null;
      el.onerror = null;
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    if (url) URL.revokeObjectURL(url);
    if (currentUrl === url) currentUrl = null;
    // Media callbacks can change the outcome while this function is suspended.
    const finalReason = reason as SpeechFallbackReason | 'played' | 'cancelled';
    if (finalReason !== 'played' && finalReason !== 'cancelled') onStatus?.({ state: 'fallback', provider: 'browser', reason: finalReason });
    // Metadata only: no answer text, identifiers, prompts, or audio in diagnostics.
    console.info('voice_speech_event', finalReason);
  }
}

/** Speak `text`; resolves when done (or immediately if unsupported). */
export function speak(text: string, lang = 'en-US', onStatus?: (status: SpeechStatus) => void): Promise<void> {
  if (!isSpeechSynthesisSupported() || !text) {
    onStatus?.({ state: 'unavailable', provider: 'browser' });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.97;
    u.pitch = 1;
    // Re-evaluate each time: Safari may load better voices after the first call.
    const v = selectSpeechVoice(speechSynthesis.getVoices(), lang);
    if (v) u.voice = v;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      if (finishSpeech === finish) finishSpeech = null;
      resolve();
    };
    u.onend = finish;
    u.onstart = () => onStatus?.({ state: 'playing', provider: 'browser' });
    u.onerror = () => { onStatus?.({ state: 'unavailable', provider: 'browser' }); finish(); };
    // Chrome sometimes never fires onend; don't let the state machine hang.
    const guard = window.setTimeout(finish, 1500 + text.length * 90);
    finishSpeech = finish;
    try { speechSynthesis.speak(u); }
    catch { onStatus?.({ state: 'unavailable', provider: 'browser' }); finish(); }
  });
}

export function stopSpeaking(): void {
  cancelRemote?.();
  finishSpeech?.();
  if (audioEl && !audioEl.paused) {
    try {
      audioEl.pause();
    } catch {
      // ignore
    }
  }
  if (isSpeechSynthesisSupported()) speechSynthesis.cancel();
}
