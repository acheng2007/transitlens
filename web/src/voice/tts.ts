// Text-to-speech. Two paths:
//   1. speakRemote(): fetch MP3 from the voice service (Grok's "Leo" voice) and play it.
//   2. speak(): the browser's speechSynthesis, used as the fallback.

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

let preferredVoice: SpeechSynthesisVoice | null = null;

// One <audio> element, created and "unlocked" inside the Start tap, reused for every answer.
// Android Chrome only allows play() without a gesture on an element that already played once.
let audioEl: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (preferredVoice) return preferredVoice;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const base = lang.split('-')[0];
  preferredVoice =
    voices.find((v) => v.lang === lang && /google/i.test(v.name)) ??
    voices.find((v) => v.lang === lang) ??
    voices.find((v) => v.lang.startsWith(base)) ??
    voices[0];
  return preferredVoice;
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

/**
 * Fetch `text` as audio from the voice service and play it. Returns false (without
 * playing anything) if the service, the fetch, or playback fails, so the caller can
 * fall back to speak().
 */
export async function speakRemote(text: string, endpoint: string, timeoutMs = 8000): Promise<boolean> {
  if (!audioEl || !text) return false;
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const blob = await res.blob();
    if (!blob.size) return false;
    const el = audioEl;
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(blob);
    el.src = currentUrl;
    await new Promise<void>((resolve, reject) => {
      el.onended = () => resolve();
      el.onerror = () => reject(new Error('audio playback error'));
      el.play().catch(reject);
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Speak `text`; resolves when done (or immediately if unsupported). */
export function speak(text: string, lang = 'en-US'): Promise<void> {
  if (!isSpeechSynthesisSupported() || !text) return Promise.resolve();
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 1.05;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    // Chrome sometimes never fires onend; don't let the state machine hang.
    const guard = window.setTimeout(finish, 1500 + text.length * 90);
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking(): void {
  if (audioEl && !audioEl.paused) {
    try {
      audioEl.pause();
    } catch {
      // ignore
    }
  }
  if (isSpeechSynthesisSupported()) speechSynthesis.cancel();
}
