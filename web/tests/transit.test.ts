import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBusFocus, startBusFeed } from '../src/buses.ts';
import { safariRotation, startOrientation, requestOrientationPermission } from '../src/orientation.ts';
import { signedDiffDeg, normalizeDeg, projectX, visibleHalfTan } from '../src/geo.ts';
import { cardLines, statusTag } from '../src/format.ts';
import type { Bus } from '../../shared/transit.ts';

const bus: Bus = { id: '2417', route: '38', destination: null, lat: 29.65, lon: -82.35, headingDeg: null, speedMph: null, delayed: null, passengerLoad: null, distanceKm: 0.3, bearingDeg: 0 };

test('shared dwell uses wraparound, resets on target changes, and clears on compass loss', () => {
  const f = createBusFocus();
  assert.equal(f.update([bus], 359, 0), null);
  assert.equal(f.update([bus], 359, 649), null);
  assert.equal(f.update([bus], 359, 650), bus.id);
  assert.equal(f.update([{ ...bus, id: 'other' }], 0, 700), null);
  assert.equal(f.update([bus], null, 1400), null);
  assert.equal(f.update([bus], 0, 1500), null);
  assert.equal(f.update([bus], 0, 2150), bus.id);
  assert.equal(f.update([], 0, 2200), null);
});

test('dwell progress is read-only and matches selection timing', () => {
  const f = createBusFocus();
  assert.deepEqual(f.progress(0), { id: null, t: 0 });
  assert.equal(f.update([bus], 0, 1000), null);
  assert.deepEqual(f.progress(1325), { id: bus.id, t: 0.5 });
  assert.deepEqual(f.progress(5000), { id: bus.id, t: 1 });
  assert.equal(f.update([bus], 0, 1650), bus.id);
});

test('nullable transit card preserves unknown delay and speed', () => {
  assert.deepEqual(cardLines(bus), ['ROUTE 38 · Destination unknown', '0.19 mi']);
  assert.equal(statusTag(bus), null);
  assert.equal(statusTag({ ...bus, delayed: false }), 'NO DELAY REPORTED');
  assert.equal(cardLines({ ...bus, speedMph: 0 })[1], '0.19 mi · Stopped');
  assert.equal(cardLines({ ...bus, speedMph: 14.6, passengerLoad: 'HALF_EMPTY' })[1], '0.19 mi · 15 mph · Half full');
});

test('pinhole and signed geographic direction retain wraparound and left/right', () => {
  assert.equal(signedDiffDeg(1, 359), 2);
  assert.equal(signedDiffDeg(359, 1), -2);
  assert.ok(projectX(-10, 0.7, 400)! < 200);
  assert.ok(projectX(10, 0.7, 400)! > 200);
});

test('Safari rear-camera matrix supports both landscape rotations and cardinal headings', () => {
  for (const heading of [0, 90, 180, 270, 359]) {
    // Same north-facing camera, device top points east in one landscape
    // direction and west in the other. Beta/gamma retain the camera transform.
    for (const [compass, beta, gamma] of [[heading + 90, 0, 90], [heading - 90, 0, -90], [heading, 90, 0]]) {
      const r = safariRotation(normalizeDeg(compass), beta, gamma);
      const camera = normalizeDeg(Math.atan2(-r[2], -r[5]) * 180 / Math.PI);
      assert.ok(Math.abs(signedDiffDeg(camera, heading)) < 1e-6);
    }
  }
});

test('upright iPhone (portrait) follows the compass heading despite noisy gamma near gimbal lock', () => {
  for (const heading of [0, 90, 225]) {
    for (const [beta, gamma] of [[90, 40], [88, -65], [80, 12]]) {
      const r = safariRotation(heading, beta, gamma);
      const camera = normalizeDeg(Math.atan2(-r[2], -r[5]) * 180 / Math.PI);
      assert.ok(Math.abs(signedDiffDeg(camera, heading)) < 1e-6, `${heading} ${beta} ${gamma} -> ${camera}`);
    }
  }
  // Tilted toward flat, gamma still applies as before (landscape Cardboard keeps beta near 0).
  const r = safariRotation(90, 0, 90);
  assert.ok(Math.abs(signedDiffDeg(normalizeDeg(Math.atan2(-r[2], -r[5]) * 180 / Math.PI), 0)) < 1e-6);
});

test('visible FOV uses the short camera edge when the stream is portrait (phone held upright)', () => {
  // Landscape Cardboard eye, 4:3 landscape stream: unchanged.
  assert.equal(visibleHalfTan(0.7, 1, 1, 4 / 3, 1), 0.7 * 0.75);
  // Portrait phone screen (390x844) with a portrait 3:4 stream: short edge (x0.75), then cover-crop.
  const portrait = visibleHalfTan(0.7, 1, 390 / 844, 3 / 4, 1);
  assert.ok(Math.abs(portrait - 0.7 * 0.75 * ((390 / 844) / 0.75)) < 1e-9);
  // Landscape phone screen with a landscape stream: full long edge.
  assert.equal(visibleHalfTan(0.7, 1, 844 / 390, 4 / 3, 1), 0.7);
});

test('Safari permission denial is visible to startup and declination is applied once', async () => {
  const target = new EventTarget();
  Object.assign(globalThis, { window: Object.assign(target, { DeviceOrientationEvent: { requestPermission: async () => 'denied' }, setTimeout, clearTimeout }) });
  assert.equal(await requestOrientationPermission(), false);
  const tracker = startOrientation(true, () => -6);
  const event = Object.assign(new Event('deviceorientation'), { alpha: 123, beta: 90, gamma: 0, absolute: false, webkitCompassHeading: 1 });
  target.dispatchEvent(event);
  assert.equal(tracker.get()?.source, 'safari-compass');
  assert.ok(Math.abs(signedDiffDeg(tracker.get()!.headingDeg, 355)) < 1e-6);
  tracker.stop();
  target.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha: 0, beta: 90, gamma: 0, absolute: false, webkitCompassHeading: 90 }));
  assert.ok(Math.abs(signedDiffDeg(tracker.get()!.headingDeg, 355)) < 1e-6);
});

test('polling has one request, aborts on exit, and ignores late responses', async () => {
  Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
  let resolve: (value: unknown) => void = () => {};
  let calls = 0;
  let signal: AbortSignal | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, opts: RequestInit) => {
    calls++;
    assert.ok(url.includes('fovDeg=360'));
    signal = opts.signal as AbortSignal;
    return new Promise(r => { resolve = r; });
  }) as typeof fetch;
  try {
    const feed = startBusFeed({ getPosition: () => ({ lat: 29.6465, lon: -82.3478 }), positionStatus: () => '', radiusKm: 5 });
    assert.equal(calls, 1);
    feed.stop();
    assert.ok(signal?.aborted);
    resolve({ ok: true, json: async () => ({ demo: false, status: 'available', buses: [bus] }) });
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(feed.get().buses, []);
  } finally { globalThis.fetch = original; }
});

test('stopping a cast while the offer is loading cannot recreate a peer connection', async () => {
  const { startCastPublisher } = await import('../src/cast/publisher.ts');
  Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
  let resolve: (value: unknown) => void = () => {};
  let peers = 0;
  const originalFetch = globalThis.fetch;
  const originalPeer = globalThis.RTCPeerConnection;
  globalThis.fetch = (() => new Promise(r => { resolve = r; })) as typeof fetch;
  globalThis.RTCPeerConnection = class {
    constructor() { peers++; }
    addTrack() {}
    setRemoteDescription() { return new Promise(() => {}); }
    close() {}
  } as unknown as typeof RTCPeerConnection;
  try {
    const publisher = startCastPublisher({ getTracks: () => [] } as unknown as MediaStream, () => {});
    publisher.stop();
    resolve({ status: 200, json: async () => ({ id: 1, sdp: 'test-offer' }) });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(peers, 0);
  } finally { globalThis.fetch = originalFetch; globalThis.RTCPeerConnection = originalPeer; }
});

test('compass and minimap heading remain available when the correction service is down', () => {
  const target = new EventTarget();
  Object.assign(globalThis, { window: Object.assign(target, { setTimeout, clearTimeout }) });
  let correction: number | null = null;
  const tracker = startOrientation(true, () => correction);
  target.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 90, gamma: 0, webkitCompassHeading: 90 }));
  assert.equal(tracker.get()?.northReference, 'magnetic');
  assert.ok(Math.abs(signedDiffDeg(tracker.get()!.headingDeg, 90)) < 1e-6);
  correction = -6;
  assert.equal(tracker.get()?.northReference, 'true');
  assert.ok(Math.abs(signedDiffDeg(tracker.get()!.headingDeg, 84)) < 1e-6);
  tracker.stop();
});
