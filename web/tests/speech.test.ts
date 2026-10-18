import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startVoice } from '../src/voice/index.ts';
import type { Recognizer } from '../src/voice/types.ts';

// No microphone, media device or provider calls.
test('a superseding question aborts synthesis and cannot speak late audio or old fallback', async () => {
  const globals = globalThis as any;
  const saved = { window: globals.window, Audio: globals.Audio, SpeechSynthesisUtterance: globals.SpeechSynthesisUtterance,
    speechSynthesis: globals.speechSynthesis, fetch: globals.fetch };
  const spoken: string[] = [];
  const playback: string[] = [];
  let starts = 0;
  let stops = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const synthesisStarted = new Promise<void>(resolve => { started = resolve; });
  let synthesisSignal: AbortSignal | undefined;
  const synth = {
    cancel() {}, getVoices: () => [],
    speak(utterance: any) {
      if (utterance.text) spoken.push(utterance.text);
      queueMicrotask(() => utterance.onend?.());
    },
  };
  globals.window = { setTimeout, clearTimeout, speechSynthesis: synth };
  globals.speechSynthesis = synth;
  globals.SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  globals.Audio = class {
    paused = true;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public src: string) {}
    play() { this.paused = false; playback.push(this.src); return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() { this.src = ''; }
  };
  globals.fetch = async (_url: string, options: RequestInit) => {
    assert.deepEqual(JSON.parse(String(options.body)), { speechId: 'a'.repeat(43) });
    synthesisSignal = options.signal ?? undefined;
    started();
    // Deliberately ignore abort to model a late completion from a network adapter.
    await pending;
    const wav = new Uint8Array(44);
    wav.set([82, 73, 70, 70], 0);
    wav.set([87, 65, 86, 69], 8);
    return new Response(wav, { headers: { 'content-type': 'audio/wav' } });
  };
  const recognizer = { start() { starts++; }, stop() { stops++; }, onResult: null, onError: null };
  const voice = startVoice({
    recognizer, ttsEndpoint: '/api/voice/tts',
    requestAnswer: async question => question === 'first'
      ? { answer: 'Old approved answer.', speechId: 'a'.repeat(43), speechText: 'Old approved answer.' }
      : 'New answer.',
    onStateChange() {}, onAnswer() {},
  });
  try {
    const old = voice.ask('first');
    await synthesisStarted;
    assert.equal(voice.getState(), 'speaking');
    await voice.ask('second');
    assert.ok(synthesisSignal?.aborted);
    release();
    await old;
    assert.deepEqual(spoken, ['New answer.']);
    assert.ok(playback.every(url => url.startsWith('data:')));
    assert.equal(stops, 0);
    assert.equal(starts, 1);
    assert.equal(voice.getState(), 'idle');
  } finally {
    voice.stop();
    Object.assign(globals, saved);
  }
});

test('one spoken question with interim updates sends one request and does not retry a fallback', async () => {
  const globals = globalThis as any;
  const saved = { window: globals.window, Audio: globals.Audio, SpeechSynthesisUtterance: globals.SpeechSynthesisUtterance,
    speechSynthesis: globals.speechSynthesis };
  const synth = { cancel() {}, getVoices: () => [], speak(u: any) { queueMicrotask(() => u.onend?.()); } };
  globals.window = { setTimeout, clearTimeout, speechSynthesis: synth };
  globals.speechSynthesis = synth;
  globals.SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  globals.Audio = class {
    paused = true;
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() {}
  };
  const questions: string[] = [];
  const recognizer: Recognizer = { start() {}, stop() {}, onResult: null, onError: null };
  let completed!: () => void;
  const answered = new Promise<void>(resolve => { completed = resolve; });
  const voice = startVoice({ recognizer, speak: false, endOfQuestionSilenceMs: 5,
    requestAnswer: async question => { questions.push(question); return 'The assistant is temporarily unavailable.'; },
    onStateChange() {}, onAnswer() { completed(); },
  });
  try {
    recognizer.onResult?.('Hey Gemini how can I get', false);
    recognizer.onResult?.('Hey Gemini how can I get to Reitz Union', false);
    recognizer.onResult?.('Hey Gemini how can I get to Reitz Union', true);
    await answered;
    // Wake-only standby must not repeat the failed request.
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(questions, ['how can i get to reitz union']);
    assert.equal(voice.getState(), 'idle');
  } finally {
    voice.stop();
    Object.assign(globals, saved);
  }
});
