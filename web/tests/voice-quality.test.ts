import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSpeechVoice, speak } from '../src/voice/tts';
import { createTransitConversation } from '../src/voice/transit';

const voice = (name: string, lang = 'en-US', isDefault = false) => ({ name, lang, default: isDefault }) as SpeechSynthesisVoice;

test('fallback prefers enhanced natural speech, respects language and avoids novelty voices', () => {
  assert.equal(selectSpeechVoice([], 'en-US'), null);
  const compact = voice('Samantha (Compact)', 'en-US', true);
  const enhanced = voice('Samantha (Enhanced)');
  const premium = voice('Ava (Premium)');
  const french = voice('French (Premium)', 'fr-FR');
  assert.equal(selectSpeechVoice([compact, enhanced, french], 'en-US'), enhanced);
  assert.equal(selectSpeechVoice([compact, enhanced, premium], 'en-US'), premium);
  assert.equal(selectSpeechVoice([voice('Zarvox', 'en-US', true), enhanced], 'en-US'), enhanced);
  assert.equal(selectSpeechVoice([premium, french], 'fr-FR'), french);
});

test('browser playback uses relaxed pacing and discovers better voices after asynchronous loading', async () => {
  const g = globalThis as any;
  const saved = { window: g.window, speechSynthesis: g.speechSynthesis, SpeechSynthesisUtterance: g.SpeechSynthesisUtterance };
  const spoken: any[] = [];
  let voices: SpeechSynthesisVoice[] = [];
  const synth = { cancel() {}, getVoices: () => voices, speak(u: any) { spoken.push(u); queueMicrotask(() => u.onend?.()); } };
  g.window = { speechSynthesis: synth, setTimeout, clearTimeout };
  g.speechSynthesis = synth;
  g.SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  try {
    await speak('The map is open.');
    const natural = voice('Samantha (Enhanced)');
    voices = [voice('Samantha (Compact)', 'en-US', true), natural];
    await speak('The stop is ahead.');
    assert.equal(spoken[1].voice, natural);
    assert.equal(spoken[1].rate, 0.97);
    assert.equal(spoken[1].pitch, 1);
  } finally { Object.assign(g, saved); }
});

test('spoken confirmations omit technical source labels while visible answers retain them', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    return Response.json({ requestId: body.requestId, answer: 'Opening the map.', source: 'local', focusedBusId: null,
      actions: [{ type: 'set_map_mode', mode: 'expanded' }] });
  };
  try {
    const conversation = createTransitConversation(() => ({ focusedBusId: null, position: null, radiusKm: 5,
      map: { mode: 'compact', extentKm: 5 } }), () => 'Map expanded.');
    const result = await conversation.askSpeech('open the map', new AbortController().signal);
    assert.equal(result.answer, 'Local transit tools. Map expanded.');
    assert.equal(result.speechText, 'Map expanded.');
    assert.equal(result.speechId, undefined);
  } finally { globalThis.fetch = oldFetch; }
});

for (const [type, action, speechText] of [
  ['expanded', { type: 'set_map_mode', mode: 'expanded' }, 'Map expanded.'],
  ['compact', { type: 'set_map_mode', mode: 'compact' }, 'Map returned to compact view.'],
  ['zoom', { type: 'set_map_extent', extentKm: 10 }, 'Map range updated.'],
  ['cancel', { type: 'clear_guidance' }, 'Guidance canceled. Back to exploring.'],
] as const) {
  test(`approved ${type} confirmation uses one matching speech capability after applying actions`, async () => {
    const oldFetch = globalThis.fetch;
    let applied = false;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      return Response.json({ requestId: body.requestId, answer: 'Map command ready.', source: 'local', focusedBusId: null,
        actions: [action], speechText, speechId: 'a'.repeat(43) });
    };
    try {
      const conversation = createTransitConversation(() => ({ focusedBusId: null, position: null, radiusKm: 5,
        map: { mode: 'compact', extentKm: 5 } }), () => { applied = true; return speechText; });
      const result = await conversation.askSpeech('change the map', new AbortController().signal);
      assert.ok(applied);
      assert.equal(result.speechText, speechText);
      assert.equal(result.speechId, 'a'.repeat(43));
    } finally { globalThis.fetch = oldFetch; }
  });
}

test('mismatched approved speech cannot claim a different action, and demo facts remain spoken', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    return Response.json({ requestId: body.requestId, answer: 'Scripted demo data. Route 38.', source: 'scripted',
      focusedBusId: null, actions: [], speechText: 'Route 38.', speechId: 'a'.repeat(43) });
  };
  try {
    const conversation = createTransitConversation(() => ({ focusedBusId: null, position: null, radiusKm: 5,
      map: { mode: 'compact', extentKm: 5 } }), () => '');
    const result = await conversation.askSpeech('which bus', new AbortController().signal);
    assert.equal(result.speechId, undefined);
    assert.equal(result.speechText, 'Scripted demo data. Route 38.');
  } finally { globalThis.fetch = oldFetch; }
});
