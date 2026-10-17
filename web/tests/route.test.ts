import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPatternCache, createRouteSelection, parsePattern } from '../src/transit-data.ts';
import type { Bus } from '../../shared/transit.ts';

const pattern = {
  id: '593', routeId: '38', routeDisplay: '38', routeName: 'Gainesville Place', routeColor: '#1ea89c',
  direction: 'INBOUND', lengthKm: 7.24, detour: false,
  points: [[29.6218, -82.3655], [29.6234, -82.3655], ['bad', 0], [29.63, -82.36]],
  stops: [{ id: '1337', name: 'Gainesville Place', lat: 29.6218, lon: -82.3655, sequence: 0, distanceKm: 0 },
    { id: 'bad', name: 'Nowhere', lat: 200, lon: 0, sequence: 1, distanceKm: 1 },
    { id: '0953', name: 'Apartments', lat: 29.6234, lon: -82.3655, sequence: 2, distanceKm: 0.24 }],
};
const bus = (id: string, patternId: string | null): Bus => ({
  id, route: '38', destination: null, lat: 29.6, lon: -82.3, headingDeg: null, speedMph: null,
  delayed: null, passengerLoad: null, distanceKm: 0.3, bearingDeg: 0, patternId,
});
const settle = () => new Promise(r => setTimeout(r, 0));

test('pattern parsing drops invalid geometry and rejects unusable or unsafe values', () => {
  const parsed = parsePattern({ pattern })!;
  assert.equal(parsed.points.length, 3);
  assert.deepEqual(parsed.stops.map(s => [s.id, s.sequence]), [['1337', 0], ['0953', 1]]);
  assert.equal(parsed.routeColor, '#1ea89c');
  assert.equal(parsePattern({ pattern: { ...pattern, routeColor: 'url(javascript:1)' } })!.routeColor, null);
  assert.equal(parsePattern({ pattern: { ...pattern, points: [[29.6, -82.3]] } }), null);
  assert.equal(parsePattern({ detail: 'Unknown pattern' }), null);
  assert.equal(parsePattern(null), null);
});

test('pattern cache fetches each ID once, retries failures later, and stops cleanly', async () => {
  const calls: string[] = [];
  let fail = true;
  const cache = createPatternCache(async id => {
    calls.push(id);
    if (fail) throw new Error('down');
    return { pattern };
  }, 1000);
  assert.equal(cache.get('593', 0), null);
  assert.equal(cache.get('593', 1), null);
  await settle();
  assert.equal(cache.get('593', 500), null);
  assert.equal(calls.length, 1);
  fail = false;
  assert.equal(cache.get('593', 1500), null);
  await settle();
  assert.equal(cache.get('593', 1600)?.routeDisplay, '38');
  assert.equal(calls.length, 2);
  cache.stop();
  assert.equal(cache.get('593', 5000), null);
  assert.equal(calls.length, 2);
});

test('pattern cache ignores a response for a different pattern', async () => {
  const cache = createPatternCache(async () => ({ pattern }), 1000);
  cache.get('other', 0);
  await settle();
  assert.equal(cache.get('other', 10), null);
});

test('route selection holds through brief focus loss but never shows a stale route for another bus', () => {
  const selection = createRouteSelection(3000);
  assert.equal(selection.update(null, 0), null);
  assert.equal(selection.update(bus('a', '593'), 100), '593');
  assert.equal(selection.update(null, 200), '593');
  assert.equal(selection.update(null, 3199), '593');
  assert.equal(selection.update(null, 3200), null);
  assert.equal(selection.update(bus('a', '593'), 4000), '593');
  assert.equal(selection.update(bus('b', null), 4100), null);
  assert.equal(selection.update(bus('c', '595'), 4200), '595');
});
