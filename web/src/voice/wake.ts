// A greeting is required so mentions of Gemini cannot activate the microphone.
const WAKE = /\b(?:hey|hay|hi|ok|okay|yo)[,\s]+(?:gemini|geminy|jemini|gem\s+in\s+eye)\b/i;

export function normalizeTranscript(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Returns the question after an explicit activation, or null for ordinary speech. */
export function matchWake(text: string): string | null {
  const t = normalizeTranscript(text);
  const m = WAKE.exec(t);
  return m ? t.slice(m.index + m[0].length).trim() : null;
}
