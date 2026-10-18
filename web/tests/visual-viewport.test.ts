import test from 'node:test';
import assert from 'node:assert/strict';
import { trackVisualViewport } from '../src/visual-viewport';

test('assistant follows keyboard resize and Safari viewport pan, then restores', () => {
  const g = globalThis as any;
  const saved = g.window;
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  g.window = Object.assign(new EventTarget(), { visualViewport: viewport, innerHeight: 844 });
  const values = new Map<string, string>();
  const target = { style: { setProperty: (key: string, value: string) => values.set(key, value) } } as unknown as HTMLElement;
  const stop = trackVisualViewport(target);
  try {
    assert.equal(values.get('--visible-height'), '844px');
    viewport.height = 390;
    viewport.dispatchEvent(new Event('resize'));
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event('scroll'));
    assert.equal(values.get('--visible-height'), '390px');
    assert.equal(values.get('--visible-top'), '120px');
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize'));
    assert.equal(values.get('--visible-height'), '844px');
    assert.equal(values.get('--visible-top'), '0px');
    stop();
    viewport.height = 100;
    viewport.dispatchEvent(new Event('resize'));
    assert.equal(values.get('--visible-height'), '844px');
  } finally { stop(); g.window = saved; }
});
