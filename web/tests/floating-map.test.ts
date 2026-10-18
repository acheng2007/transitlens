import test from 'node:test';
import assert from 'node:assert/strict';
import { glassBounds } from '../src/map-panel';
import type { MapFrame } from '../src/street-map';
import { createJourneyState } from '../src/journey-state';
import { applyMapAction, createMapState } from '../src/map-state';
import { createTransitConversation } from '../src/voice/transit';

function recordingCanvas() {
  const images: any[] = [], text: string[] = [];
  const stack: any[] = [];
  const props: any = { globalAlpha: 1, font: '', canvas: { width: 480, height: 360 } };
  const ctx = new Proxy(props, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'save') return () => stack.push({ globalAlpha: target.globalAlpha, font: target.font });
      if (key === 'restore') return () => Object.assign(target, stack.pop());
      if (key === 'drawImage') return (...args: any[]) => images.push({ args, alpha: target.globalAlpha });
      if (key === 'fillText') return (value: string) => text.push(value);
      if (key === 'measureText') return (value: string) => ({ width: value.length * 5 });
      if (String(key).startsWith('create')) return () => ({ addColorStop() {} });
      return () => {};
    },
  }) as CanvasRenderingContext2D;
  return { ctx, images, text };
}

test('expanded Cardboard draws identical transparent layers in both eyes, independent of replies', async () => {
  const g = globalThis as any;
  const original = g.Path2D;
  g.Path2D = class { constructor() { return new Proxy(this, { get: () => () => {} }); } };
  try {
    const { drawHud } = await import('../src/hud');
    const frame = { canvas: { width: 1024, height: 512 }, baseCanvas: { name: 'roads', width: 1024, height: 512 }, overlayCanvas: { name: 'transit', width: 1024, height: 512 },
      status: 'Road map unavailable - radar', extentKm: 2.5, northUp: true, mode: 'expanded', located: true } as unknown as MapFrame;
    const state = { headingDeg: null, halfTan: 0.7, buses: [], selectedFocusId: null, expandedMap: true,
      mapFrame: frame, status: 'Compass unavailable', timeMs: 1, voice: null, journey: createJourneyState(), handheld: false };
    for (const [w, h] of [[480, 360], [390, 844], [300, 250]]) {
      const a = recordingCanvas(), b = recordingCanvas();
      drawHud(a.ctx, w, h, state);
      drawHud(b.ctx, w, h, { ...state, voice: { state: 'speaking', transcript: 'Full size the map',
        answer: 'A long reply '.repeat(90), error: null, speechLabel: 'Gemini voice' } });
      assert.deepEqual(a.images, b.images);
      assert.ok(b.text.includes('GEMINI VOICE'));
      assert.deepEqual(a.images.map(i => i.alpha), [0.30, 1]);
      assert.equal(b.text.filter(t => t.includes('long reply')).length, 3);
      assert.ok(b.text.includes('Road map unavailable - radar'));
      assert.ok(b.text.some(t => t.includes('no compass')));
      const bounds = glassBounds(w, h, false);
      assert.ok(bounds.w >= w * 0.9 && bounds.h >= h * 0.9 - 1e-9);
      assert.ok(Math.abs(bounds.x + bounds.w / 2 - w / 2) < 1e-9);
      const phone = recordingCanvas();
      drawHud(phone.ctx, w, h, { ...state, handheld: true, mobile: true });
      assert.equal(phone.images.length, 2);
      assert.equal(phone.images[0].args[0], frame.baseCanvas);
      const closing = recordingCanvas();
      drawHud(closing.ctx, w, h, { ...state, mapFrame: { ...frame, mode: 'compact' },
        mapPanel: { visible: true, openT: 0.5, yawOffsetDeg: 3, pitchOffsetDeg: -2 } });
      assert.deepEqual(closing.images.map(i => i.alpha), [0.15, 0.5]);
      assert.equal(closing.images[0].args[0], frame.baseCanvas);
      const unlocated = recordingCanvas();
      drawHud(unlocated.ctx, w, h, { ...state, mapFrame: { ...frame, located: false } });
      assert.equal(unlocated.images.length, 1);
      assert.equal(unlocated.images[0].args[0], frame.baseCanvas);
      assert.ok(unlocated.text.includes('Waiting for location'));
    }
  } finally { g.Path2D = original; }
});

test('a validated map-only voice action opens and closes without changing geographic range', async () => {
  const oldFetch = globalThis.fetch;
  let map = createMapState(2.5);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    return Response.json({ requestId: body.requestId, answer: 'Map updated.', source: 'local', focusedBusId: null,
      actions: [{ type: 'set_map_mode', mode: body.question === 'close the map' ? 'compact' : 'expanded' }] });
  };
  try {
    const conversation = createTransitConversation(() => ({ focusedBusId: null, position: null, radiusKm: 5,
      map: { mode: map.mode, extentKm: map.extentKm } }), actions => {
      actions.forEach(action => { if (action.type === 'set_map_mode') map = applyMapAction(map, action); });
      return 'Map updated.';
    });
    for (const phrase of ['full size the map', 'make the map bigger', 'show the full map', 'make the map full size']) {
      await conversation.ask(phrase, new AbortController().signal);
      assert.equal(map.mode, 'expanded');
      assert.equal(map.extentKm, 2.5);
      await conversation.ask('close the map', new AbortController().signal);
      assert.equal(map.mode, 'compact');
    }
  } finally { globalThis.fetch = oldFetch; }
});
