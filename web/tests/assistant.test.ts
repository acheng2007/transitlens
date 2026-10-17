import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransitConversation, parseTransitReply } from '../src/voice/transit.ts';
import { createMapState, applyMapAction } from '../src/map-state.ts';
import { matchWake } from '../src/voice/wake.ts';

const context = { focusedBusId: '2417', position: { lat: 29.6465, lon: -82.3478 }, radiusKm: 5, map: { mode: 'compact' as const, extentKm: 5 } };
const reply = { requestId: 'request', answer: 'Preparing the map.', actions: [{ type: 'set_map_mode', mode: 'expanded' }], source: 'gemini', focusedBusId: '2417' };

test('Hey Gemini supports a question, bare activation, punctuation and normal conversation', () => {
  assert.equal(matchWake('Hey Gemini, where is this bus going?'), 'where is this bus going');
  assert.equal(matchWake('Okay Gemini'), '');
  assert.equal(matchWake('Gemini zoom in'), null);
  assert.equal(matchWake('where is this bus going'), null);
});

test('reject stale IDs, arbitrary actions, partial invalid batches, and invalid map ranges', () => {
  assert.deepEqual(parseTransitReply(reply, 'request'), reply);
  for (const bad of [
    { ...reply, requestId: 'old' }, { ...reply, answer: '' },
    { ...reply, actions: [{ type: 'execute', url: 'https://example.com' }] },
    { ...reply, actions: [...reply.actions, { type: 'set_map_extent', extentKm: Infinity }] },
    { ...reply, actions: [{ type: 'set_map_extent', extentKm: 0 }] },
    { ...reply, actions: [{ type: 'set_map_mode', mode: 'expanded', script: 'bad' }] },
  ]) assert.throws(() => parseTransitReply(bad, 'request'));
});

test('captured gaze, bounded follow-ups and actual map results survive model claims', async () => {
  const original = globalThis.fetch;
  const requests: any[] = [];
  let state = createMapState(5);
  let focus = '2417';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    requests.push(body);
    return Response.json({ ...reply, requestId: body.requestId });
  };
  try {
    const conversation = createTransitConversation(() => ({ ...context, focusedBusId: focus }), actions => {
      actions.forEach(a => { state = applyMapAction(state, a); });
      return 'Map expanded.';
    });
    conversation.capture();
    focus = 'other-bus';
    assert.equal(await conversation.ask('Expand the map', new AbortController().signal), 'Map expanded.');
    assert.equal(state.mode, 'expanded');
    assert.equal(requests[0].context.focusedBusId, '2417');
    for (let i = 0; i < 6; i++) await conversation.ask('Zoom out', new AbortController().signal);
    assert.equal(requests.at(-1).history.length, 4);
    assert.equal(requests.at(-1).context.previousBusId, '2417');
    conversation.reset();
    await conversation.ask('New session', new AbortController().signal);
    assert.equal(requests.at(-1).history.length, 0);
    assert.equal(requests.at(-1).context.previousBusId, null);
  } finally { globalThis.fetch = original; }
});

test('a late duplicate or stopped-session response cannot apply an action', async () => {
  const original = globalThis.fetch;
  const pending: Array<() => void> = [];
  let applied = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    await new Promise<void>(resolve => pending.push(resolve));
    return Response.json({ ...reply, requestId: body.requestId });
  };
  try {
    const conversation = createTransitConversation(() => context, () => { applied++; return 'Applied'; });
    const first = conversation.ask('Expand', new AbortController().signal);
    const firstRejected = assert.rejects(first, /stale/);
    const second = conversation.ask('Close', new AbortController().signal);
    pending[1]();
    await second;
    pending[0]();
    await firstRejected;
    assert.equal(applied, 1);
    const stopped = conversation.ask('Expand', new AbortController().signal);
    const stoppedRejected = assert.rejects(stopped, /stale/);
    conversation.reset();
    pending[2]();
    await stoppedRejected;
    assert.equal(applied, 1);
  } finally { globalThis.fetch = original; }
});

test('wake transcript freezes gaze, reaches the transit request and applies one visible map result', async () => {
  const { startVoice } = await import('../src/voice/index.ts');
  const originalWindow = (globalThis as any).window;
  const originalFetch = globalThis.fetch;
  (globalThis as any).window = { setTimeout, clearTimeout };
  let focusedBusId = '2417';
  let sentBus: string | null = null;
  let map = createMapState(5);
  let resolveAnswer!: (text: string) => void;
  const answered = new Promise<string>(resolve => { resolveAnswer = resolve; });
  const rec = { start() {}, stop() {}, onResult: null as ((t: string, final: boolean) => void) | null, onError: null as ((m: string, fatal: boolean) => void) | null };
  const conversation = createTransitConversation(() => ({ ...context, focusedBusId }), actions => {
    actions.forEach(action => { map = applyMapAction(map, action); });
    return 'Map expanded.';
  });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    sentBus = body.context.focusedBusId;
    return Response.json({ ...reply, requestId: body.requestId });
  };
  const voice = startVoice({
    recognizer: rec, speak: false, endOfQuestionSilenceMs: 1,
    onCaptureStart: () => conversation.capture(), requestAnswer: conversation.ask,
    onStateChange() {}, onAnswer: resolveAnswer,
  });
  try {
    rec.onResult!('Hey Gemini', true);
    focusedBusId = 'turned-away';
    rec.onResult!('Expand the map', true);
    assert.equal(await answered, 'Map expanded.');
    assert.equal(sentBus, '2417');
    assert.equal(map.mode, 'expanded');
    // Mic denial does not disable the direct typed-question API.
    rec.onError!('Microphone permission denied', true);
    await voice.ask('Expand the map');
    assert.equal(voice.getState(), 'idle');
  } finally {
    voice.stop();
    globalThis.fetch = originalFetch;
    (globalThis as any).window = originalWindow;
  }
});
