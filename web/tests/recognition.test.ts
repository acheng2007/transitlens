import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRecognizer } from '../src/voice/recognition';

test('browser speech preserves batched phrases and ignores retired recognition sessions', () => {
  const g = globalThis as any;
  const saved = { window: g.window, document: g.document };
  const instances: any[] = [];
  const events = new EventTarget();
  const doc = { visibilityState: 'visible', addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events) };
  class SpeechRecognition {
    onresult: any; onend: any; onerror: any;
    start() {} abort() {}
    constructor() { instances.push(this); }
  }
  g.document = doc;
  g.window = { SpeechRecognition, setTimeout, clearTimeout };
  const recognizer = createBrowserRecognizer();
  const heard: unknown[] = [];
  recognizer.onResult = (text, final) => heard.push([text, final]);
  const result = (text: string, isFinal: boolean) => ({ 0: { transcript: text }, isFinal });
  try {
    recognizer.start();
    const first = instances[0];
    first.onresult({ resultIndex: 0, results: [result('Hey Gemini', true), result('take me to', true), result('Reitz Union', false)] });
    first.onresult({ resultIndex: 2, results: [result('Hey Gemini', true), result('take me to', true), result('Reitz Union', true)] });
    assert.deepEqual(heard, [['Hey Gemini', true], ['take me to', true], ['Reitz Union', false], ['Reitz Union', true]]);
    recognizer.stop();
    recognizer.start();
    first.onresult?.({ resultIndex: 0, results: [result('old question', true)] });
    assert.equal(heard.length, 4);
    assert.equal(instances.length, 2);
    doc.visibilityState = 'hidden';
    events.dispatchEvent(new Event('visibilitychange'));
    instances[1].onresult?.({ resultIndex: 0, results: [result('background question', true)] });
    assert.equal(heard.length, 4);
    doc.visibilityState = 'visible';
    events.dispatchEvent(new Event('visibilitychange'));
    assert.equal(instances.length, 3);
    recognizer.stop();
    events.dispatchEvent(new Event('visibilitychange'));
    assert.equal(instances.length, 3);
  } finally {
    recognizer.stop();
    Object.assign(g, saved);
  }
});


test('wake recognition restarts once after silence and never restarts after permission denial', async () => {
  const g = globalThis as any;
  const saved = { window: g.window, document: g.document };
  const instances: any[] = [];
  const events = new EventTarget();
  const doc = { visibilityState: 'visible', addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events) };
  class SpeechRecognition {
    onresult: any; onend: any; onerror: any;
    start() {} abort() {}
    constructor() { instances.push(this); }
  }
  g.document = doc;
  g.window = { SpeechRecognition, setTimeout, clearTimeout };
  const recognizer = createBrowserRecognizer();
  let fatal = false;
  recognizer.onError = (_message, value) => { fatal = value; };
  try {
    recognizer.start(); recognizer.start();
    assert.equal(instances.length, 1);
    instances[0].onend(); instances[0].onend();
    await new Promise(resolve => setTimeout(resolve, 175));
    assert.equal(instances.length, 2);
    instances[1].onerror({ error: 'not-allowed' });
    instances[1].onend();
    events.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve => setTimeout(resolve, 175));
    assert.ok(fatal);
    assert.equal(instances.length, 2);
  } finally { recognizer.stop(); Object.assign(g, saved); }
});
