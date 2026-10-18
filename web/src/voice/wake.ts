// A greeting is required so mentions of Gemini cannot activate the microphone.
const WAKE = /\b(?:hey|hay|hi|ok|okay|yo)[,\s]+(?:gemini|geminy|jemini|gem\s+in\s+eye)\b/i;

export function normalizeTranscript(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Latest activation wins when a browser keeps extending one interim transcript. */
export function scanWake(text: string): { question: string; count: number } | null {
  const t = normalizeTranscript(text);
  const matches = [...t.matchAll(new RegExp(WAKE.source, 'gi'))];
  const m = matches.at(-1);
  return m ? { question: t.slice(m.index! + m[0].length).trim(), count: matches.length } : null;
}

/** Returns the question after an explicit activation, or null for ordinary speech. */
export function matchWake(text: string): string | null {
  return scanWake(text)?.question ?? null;
}
