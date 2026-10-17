// Fuzzy "hey grok" detection. Speech-to-text mangles "grok" constantly
// ("grock", "rock", "croc", "grog"...) so we match a family of sounds.

const GREETINGS = '(?:hey|hay|hi|ok|okay|yo|a|hey\\s+a)';
const NAMES = '(?:grok|grock|grokk|grog|groc|croc|crock|rock|brock|gronk|krok|crack|grack|graak|drock)';

// "hey grok", "hey grock", "a grok", "okay rock" ...
const WAKE_WITH_GREETING = new RegExp(`\\b${GREETINGS}[,\\s]+${NAMES}\\b`, 'i');
// Bare "grok" (rare enough as a word that it's safe alone; "rock" alone is not).
const WAKE_BARE = /\b(?:grok|grock|grokk)\b/i;

export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns null if no wake phrase, otherwise the text after it (may be '').
 * "hey grok what plane is that" -> "what plane is that"
 * "hey grok"                    -> ""
 */
export function matchWake(text: string): string | null {
  const t = normalizeTranscript(text);
  const m = WAKE_WITH_GREETING.exec(t) ?? WAKE_BARE.exec(t);
  if (!m) return null;
  return t.slice(m.index + m[0].length).replace(/^[,\s]+/, '').trim();
}
