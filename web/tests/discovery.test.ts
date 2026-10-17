import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewProjection } from '../src/discovery.ts';
import { DEMO_PATTERNS } from '../src/demo.ts';
import { mercatorPoint } from '../src/map-state.ts';

test('every captured route and its stops fit the preview without changing geographic orientation', () => {
  for (const route of DEMO_PATTERNS) {
    const project = previewProjection(route);
    for (const point of [...route.shape, ...route.stops]) {
      const [x, y] = project(point);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(x >= 59.999 && x <= 420.001 && y >= 34.999 && y <= 225.001);
    }
    const center = route.shape[0];
    const here = project(center), north = project({ ...center, lat: center.lat + 0.001 }), east = project({ ...center, lon: center.lon + 0.001 });
    assert.ok(north[1] < here[1]);
    assert.ok(east[0] > here[0]);
  }
});

test('route preview preserves Mercator aspect rather than stretching routes to the panel', () => {
  const route = DEMO_PATTERNS[0];
  const project = previewProjection(route);
  const origin = route.shape[0];
  const a = { ...origin, lat: origin.lat + 0.001 }, b = { ...origin, lon: origin.lon + 0.001 };
  const p = project(origin), px = project(b), py = project(a);
  const m = mercatorPoint(origin), mx = mercatorPoint(b), my = mercatorPoint(a);
  const xScale = (px[0] - p[0]) / (mx[0] - m[0]);
  const yScale = (py[1] - p[1]) / (my[1] - m[1]);
  assert.ok(Math.abs(xScale / yScale - 1) < 1e-6);
});
