import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeTransitEndpoint } from '../../app/android/src/transit.ts';
import { startBusFeed } from '../src/buses.ts';

test('native transit requires an HTTPS server, while desktop can use the local bus proxy', () => {
  assert.equal(nativeTransitEndpoint(undefined, true), null);
  assert.equal(nativeTransitEndpoint('', true), null);
  assert.equal(nativeTransitEndpoint('http://example.com', true), null);
  assert.equal(nativeTransitEndpoint('file:///private/data', true), null);
  assert.equal(nativeTransitEndpoint('invalid URL', true), null);
  assert.equal(nativeTransitEndpoint('https://transit.example.com', true), 'https://transit.example.com/api/buses/nearby');
  assert.equal(nativeTransitEndpoint(undefined, false), '/api/buses/nearby');
  assert.equal(nativeTransitEndpoint('http://localhost:8003', false), 'http://localhost:8003/api/buses/nearby');
});

test('native bus requests go to the application server and retain transit metadata', async () => {
  const originalFetch = globalThis.fetch;
  const oldWindow = (globalThis as any).window;
  (globalThis as any).window = { setTimeout, clearTimeout };
  let requested = '';
  globalThis.fetch = async url => {
    requested = String(url);
    return Response.json({ center: { lat: 29.6465, lon: -82.3478 }, demo: false, status: 'available',
      fetchedAt: new Date().toISOString(), magneticDeclinationDeg: -6,
      buses: [{ id: '2417', route: '38', destination: 'Reitz Union', lat: 29.6465, lon: -82.3478,
        distanceKm: 0, bearingDeg: 0, headingDeg: null, speedMph: null, delayed: null, passengerLoad: null }] });
  };
  const feed = startBusFeed({ endpoint: nativeTransitEndpoint('https://transit.example.com', true)!,
    radiusKm: 5, getPosition: () => ({ lat: 29.6465, lon: -82.3478 }), positionStatus: () => '' });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(requested.startsWith('https://transit.example.com/api/buses/nearby?'));
    assert.equal(new URL(requested).searchParams.get('fovDeg'), '360');
    assert.equal(feed.get().buses[0].route, '38');
    assert.equal(feed.get().buses[0].speedMph, null);
    assert.equal(feed.get().declinationDeg, -6);
  } finally { feed.stop(); globalThis.fetch = originalFetch; (globalThis as any).window = oldWindow; }
});
