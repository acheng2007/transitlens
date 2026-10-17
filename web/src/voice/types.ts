// Types for the voice module. `Plane` mirrors the contract in root CLAUDE.md;
// Jaiden's app can import it from here or use any structurally compatible type.

export type Plane = {
  id: string;
  callsign: string | null;
  registration: string | null;
  typeCode: string | null;
  typeName: string | null;
  airline: string | null;
  origin: string | null;
  destination: string | null;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  distanceKm: number;
  bearingDeg: number;
  offsetDeg?: number;
};

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type StartVoiceOptions = {
  /** App provides the plane closest to the center of view (or null). */
  getCurrentPlane: () => Plane | null;
  getNearbyPlanes: () => Plane[];
  onStateChange: (s: VoiceState) => void;
  /** What the user said (the question, after the wake phrase). */
  onTranscript?: (text: string) => void;
  /** The spoken answer; the app shows it in the HUD. */
  onAnswer: (text: string) => void;

  // --- Optional extras beyond the contract (all have sensible defaults) ---

  /** Non-fatal problems worth surfacing (mic denied, service offline...). */
  onError?: (message: string) => void;
  /** POST endpoint; default '/api/voice/ask' (proxied by the Vite dev server). */
  endpoint?: string;
  /** Speech recognition language; default 'en-US'. */
  lang?: string;
  /** After "hey grok" with no question, how long to wait for one. Default 8000. */
  questionTimeoutMs?: number;
  /** The question is sent once the user has been quiet this long (ms). Default 1300. */
  endOfQuestionSilenceMs?: number;
  /** Hard cap on how long one question can run before it's sent anyway (ms). Default 15000. */
  maxQuestionMs?: number;
  /** Read answers aloud. Default true. */
  speak?: boolean;
  /**
   * Endpoint that returns the answer as audio in Grok's voice; default '/api/voice/speak'.
   * Falls back to the browser's speechSynthesis if it fails. Pass null to always use the browser voice.
   */
  ttsEndpoint?: string | null;
  /** Override the recognizer (used by the dev page to fake transcripts). */
  recognizer?: Recognizer;
};

export type VoiceHandle = {
  stop: () => void;
  /** Skip the wake phrase and ask this question directly (dev page, tests). */
  ask: (question: string) => Promise<void>;
  /** Enter "listening" as if the wake phrase was heard (head-tilt trigger). */
  listen: () => void;
  getState: () => VoiceState;
};

/** Minimal speech-to-text interface so the real thing can be swapped for a fake. */
export interface Recognizer {
  start(): void;
  stop(): void;
  /** Called with the transcript of the *latest* utterance; `isFinal` once Chrome commits it. */
  onResult: ((text: string, isFinal: boolean) => void) | null;
  onError: ((message: string, fatal: boolean) => void) | null;
}
