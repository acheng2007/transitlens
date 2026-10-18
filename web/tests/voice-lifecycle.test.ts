import test from 'node:test';
import assert from 'node:assert/strict';
import { startVoice } from '../src/voice/index';
import { createBrowserRecognizer } from '../src/voice/recognition';
import type { Recognizer, SpeechStatus, SpeechResult } from '../src/voice/types';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 15));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test('wake gating and interruption across every asynchronous voice phase', async t => {
  const g = globalThis as any;
  const saved = { window: g.window, Audio: g.Audio, speechSynthesis: g.speechSynthesis,
    SpeechSynthesisUtterance: g.SpeechSynthesisUtterance, fetch: g.fetch };
  let utterance: any;
  let audio: any;
  let played: string[] = [];
  let spoken: string[] = [];
  const deadlines = new Map<number, () => void>();
  const synth = { cancel() {}, getVoices: () => [], speak(u: any) {
    if (!u.text) return;
    utterance = u; spoken.push(u.text); queueMicrotask(() => u.onstart?.());
  } };
  g.window = { setTimeout(fn: () => void, ms: number) {
    if (ms === 12000) deadlines.set(ms, fn);
    return setTimeout(fn, ms);
  }, clearTimeout, speechSynthesis: synth };
  g.speechSynthesis = synth;
  g.SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  g.Audio = class {
    paused = true; src: string; duration = 1;
    onended: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor(src: string) { this.src = src; audio = this; }
    play() { this.paused = false; played.push(this.src); return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() { this.src = ''; }
  };
  const wav = () => {
    const bytes = new Uint8Array(44); bytes.set([82,73,70,70]); bytes.set([87,65,86,69],8);
    return new Response(bytes, { headers: { 'content-type': 'audio/wav' } });
  };
  function setup(answer: (q: string, signal: AbortSignal) => Promise<string | SpeechResult>, speak = false, injected?: Recognizer) {
    played = []; spoken = [];
    const statuses: SpeechStatus[] = [];
    const requests: string[] = [];
    let starts = 0, stops = 0, captures = 0;
    const rec: Recognizer = injected ?? { start() { starts++; }, stop() { stops++; }, onResult: null, onError: null };
    const voice = startVoice({ recognizer: rec, speak, ttsEndpoint: '/api/voice/tts', questionTimeoutMs: 25,
      endOfQuestionSilenceMs: 5, requestAnswer: async (q, signal) => { requests.push(q); return answer(q, signal); },
      onCaptureStart() { captures++; }, onStateChange() {}, onAnswer() {}, onSpeechStatus: s => statuses.push(s) });
    return { voice, rec, requests, statuses, counts: () => ({ starts, stops, captures }) };
  }
  try {
    await t.test('one activation captures once, ignores late results and requires another wake', async () => {
      const x = setup(async () => 'Done.');
      try {
        x.rec.onResult?.('Hey Gemini expand', false, 'first');
        x.rec.onResult?.('Hey Gemini expand the map', false, 'first');
        x.rec.onResult?.('Hey Gemini expand the map', true, 'first');
        await tick();
        assert.equal(x.voice.getState(), 'idle');
        x.rec.onResult?.('Hey Gemini expand the map', true, 'first');
        x.rec.onResult?.('unrelated background chatter', true, 'background');
        x.rec.onResult?.('Gemini close the map', true, 'bare');
        await tick();
        assert.deepEqual(x.requests, ['expand the map']);
        x.rec.onResult?.('Hey Gemini close the map', true, 'second');
        await tick();
        assert.deepEqual(x.requests, ['expand the map', 'close the map']);
        assert.equal(x.counts().captures, 2);
        x.rec.onResult?.('Hey Gemini', true, 'silent');
        await new Promise(r => setTimeout(r, 35));
        assert.equal(x.voice.getState(), 'idle');
        assert.equal(x.requests.length, 2);
      } finally { x.voice.stop(); }
    });
    await t.test('a fresh wake in an extended interim result interrupts and captures only the new question', async () => {
      const x = setup(async () => 'Which route do you mean?', true);
      try {
        x.rec.onResult?.('Hey Gemini when does service start', false, 'continuous');
        await tick();
        assert.equal(x.voice.getState(), 'speaking');
        x.rec.onResult?.('Hey Gemini when does service start ordinary chatter', false, 'continuous');
        assert.equal(x.voice.getState(), 'speaking');
        x.rec.onResult?.('Hey Gemini when does service start Hey Gemini', false, 'continuous');
        assert.equal(x.voice.getState(), 'listening');
        x.rec.onResult?.('Hey Gemini when does service start Hey Gemini route 38', false, 'continuous');
        await tick();
        assert.deepEqual(x.requests, ['when does service start', 'route 38']);
        x.rec.onResult?.('Hey Gemini when does service start Hey Gemini route 38', true, 'continuous');
        await tick();
        assert.equal(x.requests.length, 2);
      } finally { x.voice.stop(); }
    });
    for (const provider of ['gemini', 'browser'] as const) {
      await t.test(`browser adapter accepts repeated wakes in one interim result during ${provider} playback`, async () => {
        const oldDocument = g.document;
        let native: any;
        const visibility = new EventTarget();
        g.document = { visibilityState: 'visible', addEventListener: visibility.addEventListener.bind(visibility),
          removeEventListener: visibility.removeEventListener.bind(visibility) };
        g.window.SpeechRecognition = class {
          onresult: any; onend: any; onerror: any;
          constructor() { native = this; }
          start() {} abort() {}
        };
        g.fetch = async () => provider === 'gemini' ? wav() : new Response(null, { status: 429 });
        const recognizer = createBrowserRecognizer();
        const x = setup(async () => ({ answer: 'Which route do you mean?', speechId: 'a'.repeat(43) }), true, recognizer);
        const emit = (transcript: string, isFinal = false) => native.onresult({ resultIndex: 0,
          results: [{ 0: { transcript }, isFinal }] });
        try {
          emit('Hey Gemini first question'); await tick();
          assert.ok(x.statuses.some(s => s.state === 'playing' && s.provider === provider));
          emit('Hey Gemini first question Hey Gemini');
          assert.equal(x.voice.getState(), 'listening');
          if (provider === 'gemini') assert.ok(audio.paused);
          assert.equal(x.statuses.at(-1)?.state, 'cancelled');
          emit('Hey Gemini first question Hey Gemini route 38'); await tick();
          assert.deepEqual(x.requests, ['first question', 'route 38']);
          emit('Hey Gemini first question Hey Gemini route 38 Hey Gemini zoom out'); await tick();
          assert.deepEqual(x.requests, ['first question', 'route 38', 'zoom out']);
          emit('Hey Gemini first question Hey Gemini route 38 Hey Gemini zoom out', true); await tick();
          assert.equal(x.requests.length, 3);
        } finally {
          x.voice.stop();
          delete g.window.SpeechRecognition;
          g.document = oldDocument;
        }
      });
    }
    await t.test('an extended interim wake aborts a pending answer and discards its late completion', async () => {
      const pending = deferred<string>();
      let signal: AbortSignal | undefined;
      const x = setup(async (q, currentSignal) => {
        if (q === 'first') { signal = currentSignal; return pending.promise; }
        return 'New answer.';
      });
      try {
        x.rec.onResult?.('Hey Gemini first', false, 'continuous'); await tick();
        x.rec.onResult?.('Hey Gemini first Hey Gemini second', false, 'continuous');
        assert.ok(signal?.aborted);
        await tick(); pending.resolve('Old answer.'); await tick();
        assert.deepEqual(x.requests, ['first', 'second']);
        assert.equal(x.voice.getState(), 'idle');
      } finally { x.voice.stop(); }
    });
    await t.test('a late final after interim submission cannot reopen capture', async () => {
      const x = setup(async () => 'Done.');
      try {
        x.rec.onResult?.('Hey Gemini open the map', false, 'interim');
        await tick();
        x.rec.onResult?.('Hey Gemini open the map', true, 'interim');
        await tick();
        assert.deepEqual(x.requests, ['open the map']);
        assert.equal(x.voice.getState(), 'idle');
      } finally { x.voice.stop(); }
    });
    await t.test('wake interrupts thinking and a late response cannot become an answer', async () => {
      const pending = deferred<string>(); let oldSignal: AbortSignal | undefined;
      const x = setup(async (q, signal) => { if (q === 'first') { oldSignal = signal; return pending.promise; } return 'New answer.'; });
      try {
        const first = x.voice.ask('first');
        x.rec.onResult?.('Hey Gemini next question', false, 'next');
        x.rec.onResult?.('Hey Gemini next question', true, 'next');
        assert.ok(oldSignal?.aborted);
        await tick();
        pending.resolve('Old answer.'); await first;
        assert.deepEqual(x.requests, ['first', 'next question']);
        assert.equal(x.voice.getState(), 'idle');
      } finally { x.voice.stop(); }
    });
    await t.test('wake aborts pending synthesis and suppresses late fallback and audio', async () => {
      const pending = deferred<Response>(); let signal: AbortSignal | undefined;
      g.fetch = async (_url: string, opts: RequestInit) => { signal = opts.signal ?? undefined; return pending.promise; };
      const x = setup(async () => ({ answer: 'Approved old answer.', speechId: 'a'.repeat(43) }), true);
      try {
        const first = x.voice.ask('first'); await tick();
        x.rec.onResult?.('Hey Gemini', true, 'interrupt');
        assert.ok(signal?.aborted);
        assert.equal(x.voice.getState(), 'listening');
        pending.resolve(wav()); await first;
        assert.deepEqual(spoken, []);
        assert.ok(played.every(src => src.startsWith('data:')));
        assert.ok(x.statuses.some(s => s.state === 'cancelled'));
      } finally { x.voice.stop(); }
    });
    await t.test('Gemini playback stays wake-aware, ignores echo and stops before new capture', async () => {
      g.fetch = async () => wav();
      const x = setup(async () => ({ answer: 'Say Hey Gemini to ask again.', speechId: 'a'.repeat(43) }), true);
      try {
        const first = x.voice.ask('first'); await tick();
        assert.ok(x.statuses.some(s => s.state === 'playing' && s.provider === 'gemini'));
        assert.equal(x.counts().stops, 0);
        x.rec.onResult?.('Say Hey Gemini to ask again', true, 'echo');
        assert.equal(x.voice.getState(), 'speaking');
        x.rec.onResult?.('Hey Gemini new question', true, 'interrupt');
        assert.equal(audio.paused, true);
        assert.equal(x.voice.getState(), 'listening');
        await first;
        assert.equal(x.statuses.at(-1)?.state, 'cancelled');
      } finally { x.voice.stop(); }
    });
    await t.test('device playback starts truthfully, interrupts and never resumes old speech', async () => {
      const x = setup(async () => 'The stop is ahead.', true);
      try {
        const first = x.voice.ask('first'); await tick();
        assert.ok(x.statuses.some(s => s.state === 'playing' && s.provider === 'browser'));
        x.rec.onResult?.('The stop is ahead', true, 'echo');
        assert.equal(x.voice.getState(), 'speaking');
        x.rec.onResult?.('Hey Gemini', true, 'interrupt');
        await first;
        assert.equal(x.voice.getState(), 'listening');
        assert.deepEqual(spoken, ['The stop is ahead.']);
      } finally { x.voice.stop(); }
    });
    await t.test('microphone denial during speech does not misreport playback or disable typed Ask', async () => {
      const x = setup(async () => 'The stop is ahead.', true);
      try {
        const first = x.voice.ask('first'); await tick();
        x.rec.onError?.('Microphone permission denied', true);
        assert.equal(x.voice.getState(), 'speaking');
        x.voice.cancel(); await first;
        const typed = x.voice.ask('typed question'); await tick();
        utterance.onend?.(); await typed;
        assert.deepEqual(x.requests, ['first', 'typed question']);
        assert.equal(x.voice.getState(), 'idle');
      } finally { x.voice.stop(); }
    });
    for (const failure of ['quota', 'invalid_audio', 'playback', 'timeout'] as const) {
      await t.test(`${failure} reports device fallback, and cancellation stops it`, async () => {
        const pending = deferred<Response>();
        g.fetch = failure === 'timeout' ? async (_url: string, opts: RequestInit) => {
          opts.signal?.addEventListener('abort', () => pending.resolve(wav()), { once: true });
          return pending.promise;
        } : async () => failure === 'quota' ? new Response(null, { status: 429 })
          : failure === 'invalid_audio' ? new Response('bad', { headers: { 'content-type': 'audio/wav' } }) : wav();
        const x = setup(async () => ({ answer: 'Map expanded.', speechId: 'a'.repeat(43) }), true);
        try {
          const first = x.voice.ask('first'); await tick();
          if (failure === 'timeout') { deadlines.get(12000)!(); await tick(); }
          if (failure === 'playback') { audio.onerror?.(); await tick(); }
          assert.ok(x.statuses.some(s => s.state === 'fallback' && s.reason === failure));
          assert.deepEqual(spoken, ['Map expanded.']);
          x.voice.cancel(); await first;
          assert.equal(x.voice.getState(), 'idle');
        } finally { x.voice.stop(); }
      });
    }
    await t.test('successful Gemini reply plays once without an appended device confirmation', async () => {
      g.fetch = async () => wav();
      const x = setup(async () => ({ answer: 'Map expanded.', speechText: 'Map expanded.', speechId: 'a'.repeat(43) }), true);
      try {
        const first = x.voice.ask('first'); await tick(); audio.onended?.(); await first;
        assert.equal(x.voice.getState(), 'idle');
        assert.deepEqual(spoken, []);
        assert.equal(played.filter(src => src.startsWith('blob:')).length, 1);
      } finally { x.voice.stop(); }
    });
  } finally {
    utterance?.onend?.();
    Object.assign(g, saved);
  }
});
