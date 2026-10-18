import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapPanel, updateMapPanel, glassBounds, mapPanelRect } from '../src/map-panel';
import { drawMapCrop } from '../src/floating-map';

test('elapsed-time opening, closing and continuous reversals', () => {
  const panel = createMapPanel();
  const step = (mode: 'compact' | 'expanded', timeMs: number) => updateMapPanel(panel, { mode, timeMs, headingDeg: 0, pitchDeg: 0 });
  assert.equal(step('expanded', 0).openT, 0);
  assert.equal(step('expanded', 350).openT, 1);
  assert.ok(step('compact', 460).visible);
  const mid = step('compact', 460).openT;
  assert.equal(step('expanded', 460).openT, mid);
  assert.equal(step('expanded', 635).openT, 1);
  assert.equal(step('compact', 855).visible, false);
});

test('deadzone, north wraparound, smooth follow, settling and missing heading', () => {
  const panel = createMapPanel();
  const step = (headingDeg: number | null, pitchDeg: number, timeMs: number) => updateMapPanel(panel, { mode: 'expanded', headingDeg, pitchDeg, timeMs });
  step(359, 0, 0);
  const small = step(1, 6, 16);
  assert.equal(small.yawOffsetDeg, -2);
  assert.equal(small.pitchOffsetDeg, -6);
  let last = step(30, 20, 32);
  assert.ok(last.yawOffsetDeg < -20);
  for (let t = 48; t <= 3040; t += 16) last = step(30, 20, t);
  assert.ok(Math.abs(last.yawOffsetDeg) < 2);
  assert.ok(Math.abs(last.pitchOffsetDeg) < 2);
  assert.deepEqual(step(30, 20, 3056), last);
  const unavailable = step(null, 50, 3072);
  assert.equal(unavailable.yawOffsetDeg, 0);
  assert.equal(unavailable.pitchOffsetDeg, 0);
  assert.equal(step(120, 50, 3088).yawOffsetDeg, 0);
});

test('reduced motion opens and closes immediately', () => {
  const panel = createMapPanel();
  assert.equal(updateMapPanel(panel, { mode: 'expanded', headingDeg: null, pitchDeg: null, timeMs: 0, reducedMotion: true }).openT, 1);
  assert.equal(updateMapPanel(panel, { mode: 'compact', headingDeg: null, pitchDeg: null, timeMs: 1, reducedMotion: true }).visible, false);
});

test('projection and cover crops preserve shape for portrait, landscape and cast', () => {
  for (const [w, h] of [[390, 844], [844, 390], [480, 360], [1280, 720]]) {
    const rest = glassBounds(w, h, true);
    const frame = { visible: true, openT: 1, yawOffsetDeg: 0, pitchOffsetDeg: 0 };
    assert.deepEqual(mapPanelRect(w, h, 0.7, frame, rest), rest);
    const shifted = mapPanelRect(w, h, 0.7, { ...frame, yawOffsetDeg: 5, pitchOffsetDeg: 5 }, rest);
    assert.ok(shifted.x > rest.x && shifted.y < rest.y);
    const calls: number[][] = [];
    const ctx = { drawImage: (_: unknown, ...args: number[]) => calls.push(args) } as unknown as CanvasRenderingContext2D;
    drawMapCrop(ctx, { width: 1024, height: 512 } as HTMLCanvasElement, rest);
    const [sx, sy, sw, sh, , , dw, dh] = calls[0];
    assert.ok(Math.abs(sw / sh - dw / dh) < 1e-9);
    assert.equal(sx + sw / 2, 512);
    assert.equal(sy + sh / 2, 256);
  }
});

test('phone safe areas are respected on every edge', () => {
  const r = glassBounds(844, 390, true, { top: 0, right: 59, bottom: 21, left: 59 });
  assert.ok(r.x >= 69 && 844 - r.x - r.w >= 69);
  assert.ok(390 - r.y - r.h >= 31);
});
