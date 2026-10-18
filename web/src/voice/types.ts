// Transit voice capture and playback contracts.

export type SpeechResult = {
  answer: string;
  speechId?: string;
  speechText?: string;
};

export type SpeechFallbackReason = 'not_configured' | 'unavailable' | 'quota' | 'service' | 'timeout' | 'network' | 'invalid_audio' | 'playback' | 'playback_timeout';
export type SpeechStatus =
  | { state: 'preparing'; provider: 'gemini' }
  | { state: 'playing'; provider: 'gemini' | 'browser' }
  | { state: 'fallback'; provider: 'browser'; reason: SpeechFallbackReason }
  | { state: 'cancelled'; provider: null }
  | { state: 'unavailable'; provider: 'browser' };

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type StartVoiceOptions = {
  /** Transit app supplies a grounded request and validated action dispatcher. */
  requestAnswer?: (question: string, signal: AbortSignal) => Promise<string | SpeechResult>;
  /** Freeze gaze context at wake activation, before the user turns their head. */
  onCaptureStart?: () => void;
  onStateChange: (s: VoiceState) => void;
  /** What the user said (the question, after the wake phrase). */
  onPartialTranscript?: (text: string) => void;
  /** Actual playback and fallback status, separate from answer provenance. */
  onSpeechStatus?: (status: SpeechStatus) => void;
  onTranscript?: (text: string) => void;
  /** The spoken answer; the app shows it in the HUD. */
  onAnswer: (text: string) => void;

  // --- Optional extras beyond the contract (all have sensible defaults) ---

  /** Non-fatal problems worth surfacing (mic denied, service offline...). */
  onError?: (message: string) => void;
  /** Speech recognition language; default 'en-US'. */
  lang?: string;
  /** After "Hey Gemini" with no question, how long to wait for one. Default 8000. */
  questionTimeoutMs?: number;
  /** The question is sent once the user has been quiet this long (ms). Default 1300. */
  endOfQuestionSilenceMs?: number;
  /** Hard cap on how long one question can run before it's sent anyway (ms). Default 15000. */
  maxQuestionMs?: number;
  /** Read answers aloud. Default true. */
  speak?: boolean;
  /**
   * Optional endpoint accepting an approved speechId and returning WAV; default is browser speech.
   * Falls back to the browser's speechSynthesis if it fails. Pass null to always use the browser voice.
   */
  ttsEndpoint?: string | null;
  /** Override the recognizer (used by the dev page to fake transcripts). */
  recognizer?: Recognizer;
  /** Disable microphone recognition while keeping typed questions and speech output. */
  listenForWake?: boolean;
};

export type VoiceHandle = {
  stop: () => void;
  /** Abort a pending answer or speech while keeping the session available. */
  cancel: () => void;
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
  onResult: ((text: string, isFinal: boolean, utteranceId?: string) => void) | null;
  onError: ((message: string, fatal: boolean) => void) | null;
}
