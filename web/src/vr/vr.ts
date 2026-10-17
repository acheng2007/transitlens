// VR mode: renders the virtual Atlanta scene into each eye (true stereo: one camera per eye, offset
// by the IPD), driven by the phone's full 3D orientation. Aircraft come from any feed (live, demo,
// or the scripted scenario) and are placed at their real position, direction and altitude.

import * as THREE from 'three';
import type { Plane } from '../planes';
import type { Eye } from '../stereo';
import { aircraftStatus } from '../format';
import { MAG_DECLINATION_DEG } from '../orientation';
import { createAirliner, createHelicopter } from './models';
import type { AircraftModel } from './models';
import { FT, toLocal } from './local';
import { EYE_HEIGHT_M, createWorld } from './world';

/** Horizontal field of view per eye. The HUD uses the same value, so compass icons line up with the 3D planes. */
export const VR_HFOV_DEG = 80;
/** Eye separation in meters (real stereo depth for nearby things like the rooftop and low aircraft). */
const IPD_M = 0.064;
/** Aircraft are scaled up with distance so they stay visible (~constant angular size beyond this range). */
const TRUE_SCALE_RANGE_M = 220;
/** Never smaller than this multiple of true size (close aircraft still read clearly). */
const MIN_SCALE = 1.5;
/** Status halo size (fraction of the view; sprites ignore distance). */
const HALO_SIZE = 0.09;
const HALO_SIZE_FOCUSED = 0.13;
/** Head orientation smoothing per frame (0..1). Higher = snappier, lower = steadier. */
const HEAD_SMOOTHING = 0.35;
/** Position smoothing for polled (live) data, per second. */
const POSITION_SMOOTHING = 4;
const TRAIL_POINTS = 45;
const TRAIL_SAMPLE_MS = 1_000;

const STATUS_HALO: Record<string, number> = {
  emergency: 0xff3b30,
  ground: 0x9e9e9e,
  medical: 0xc77dff,
  military: 0x4cd964,
  normal: 0x4fc3f7,
};

type Tracked = {
  model: AircraftModel;
  halo: THREE.Sprite;
  trail: THREE.Line;
  trailPts: THREE.Vector3[];
  lastTrailMs: number;
  target: THREE.Vector3;
  lastTrack: number | null;
  bank: number;
  seen: boolean;
};

export type VRView = {
  /** tan(half horizontal FOV) of each eye, for the HUD. */
  halfTan: number;
  /** Compass heading (true north) the view is facing: the HUD uses this so it matches the render exactly. */
  headingDeg: () => number;
  /** Phone orientation: row-major 3x3 device->ENU rotation (magnetic), or null to keep the last pose. */
  setDeviceRotation: (r: number[] | null) => void;
  /** Desktop dev mode: look direction from heading/pitch (degrees). */
  setYawPitch: (headingDeg: number, pitchDeg: number) => void;
  /** Update aircraft and render both eyes. */
  render: (planes: Plane[], timeMs: number, focusId: string | null) => void;
  /** Eye canvas (for casting). */
  canvas: HTMLCanvasElement;
  resize: () => void;
  stop: () => void;
};

function haloTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createVRView(eyes: [Eye, Eye]): VRView {
  const world = createWorld();
  const { scene, update: updateWorld } = world;
    const halfTan = Math.tan(THREE.MathUtils.degToRad(VR_HFOV_DEG / 2));

  // Head: position on the rooftop, orientation from the phone. Eye cameras are children, offset by IPD/2.
  const head = new THREE.Object3D();
  head.position.set(0, EYE_HEIGHT_M, 0);
  scene.add(head);
  const targetQ = new THREE.Quaternion();

  // One WebGL renderer (off-DOM) renders BOTH eyes side by side into one wide canvas (left/right
  // viewports), then each half is copied into that eye's 2D canvas. Rendering an eye, copying it, then
  // re-rendering the other made the eyes flicker (the rooftop vanished in alternating eyes).
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    // Standard depth (not logarithmic): log depth mis-sorted big ground triangles near the camera and
    // drew the ground over the rooftop. Ground-level details use height + polygon offset instead.
    powerPreference: 'high-performance',
  });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.62;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
  const eyeCanvases: HTMLCanvasElement[] = [];
  const eyeCtxs: CanvasRenderingContext2D[] = [];
  const cameras: THREE.PerspectiveCamera[] = [];
  eyes.forEach((eye, i) => {
    const canvas = document.createElement('canvas');
    canvas.className = 'eye-vr';
    // Under the HUD canvas, over the (unused) video element.
    eye.root.insertBefore(canvas, eye.ctx.canvas);
    eyeCanvases.push(canvas);
    eyeCtxs.push(canvas.getContext('2d')!);
    // near 1 m (the roof is 1.7 m below the eyes), far 300 km (the sky dome is 250 km).
    const cam = new THREE.PerspectiveCamera(60, 1, 1, 300_000);
    cam.position.x = (i === 0 ? -1 : 1) * (IPD_M / 2);
    head.add(cam);
    cameras.push(cam);
  });

  const haloTex = haloTexture();
  const tracked = new Map<string, Tracked>();
  const aircraftRoot = new THREE.Group();
  scene.add(aircraftRoot);
  let lastMs = performance.now();

  let eyeW = 1;
  let eyeH = 1;
  function resize() {
    eyeW = eyes[0].root.clientWidth || 1;
    eyeH = eyes[0].root.clientHeight || 1;
    const w = eyeW;
    const h = eyeH;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w * 2, h, false);
    eyes.forEach((_, i) => {
      eyeCanvases[i].width = Math.floor(renderer.domElement.width / 2);
      eyeCanvases[i].height = renderer.domElement.height;
      const cam = cameras[i];
      cam.aspect = w / h;
      // Vertical FOV that gives the fixed horizontal FOV at this aspect.
      cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfTan / cam.aspect));
      cam.updateProjectionMatrix();
    });
  }

  // ENU (east, north, up) -> world (x = east, y = up, z = -north), then rotate magnetic -> true north.
  const declination = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(-MAG_DECLINATION_DEG),
  );
  const enuToWorld = (e: number, n: number, u: number) => new THREE.Vector3(e, u, -n);

  function setDeviceRotation(r: number[] | null) {
    if (!r) return;
    // Screen axes in device coordinates depend on the screen rotation (landscape in the headset).
    const a = THREE.MathUtils.degToRad(screen.orientation?.angle ?? (window as any).orientation ?? 0);
    const dev = (x: number, y: number, z: number) =>
      enuToWorld(r[0] * x + r[1] * y + r[2] * z, r[3] * x + r[4] * y + r[5] * z, r[6] * x + r[7] * y + r[8] * z);
    const right = dev(Math.cos(a), -Math.sin(a), 0);
    const up = dev(Math.sin(a), Math.cos(a), 0);
    const back = dev(0, 0, 1); // camera looks along -back, i.e. out of the phone's rear camera
    const m = new THREE.Matrix4().makeBasis(right, up, back);
    targetQ.setFromRotationMatrix(m).premultiply(declination);
  }

  function setYawPitch(headingDeg: number, pitchDeg: number) {
    targetQ.setFromEuler(
      new THREE.Euler(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(-headingDeg), 0, 'YXZ'),
    );
  }

  function headingDeg(): number {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(head.quaternion);
    // world x = east, -z = north
    return (THREE.MathUtils.radToDeg(Math.atan2(fwd.x, -fwd.z)) + 360) % 360;
  }

  function trackedFor(p: Plane, timeMs: number): Tracked {
    let t = tracked.get(p.id);
    if (t) return t;
    const seed = [...p.id].reduce((n, c) => n + c.charCodeAt(0), 0);
    const heavy = /A33|A35|A38|B77|B78|B74|C17|MD11/.test(p.typeCode ?? '');
    const light = /C1[5-8]|SR2|PA|BE|C20|C21/.test(p.typeCode ?? '');
    const model =
      p.kind === 'helicopter'
        ? createHelicopter({ medical: p.medical, seed })
        : createAirliner({ airline: p.airline, military: p.military, size: heavy ? 1.6 : light ? 0.35 : 1, seed });
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: haloTex, color: 0x4fc3f7, transparent: true, depthWrite: false, sizeAttenuation: false }),
    );
    // Fixed-size buffer (Three.js can't grow a geometry in place); draw range grows as points arrive.
    const trailGeom = new THREE.BufferGeometry();
    trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
    trailGeom.setDrawRange(0, 0);
    const trail = new THREE.Line(
      trailGeom,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
    );
    trail.frustumCulled = false;
    aircraftRoot.add(model.group, halo, trail);
    t = { model, halo, trail, trailPts: [], lastTrailMs: timeMs, target: new THREE.Vector3(), lastTrack: null, bank: 0, seen: true };
    tracked.set(p.id, t);
    return t;
  }

  function render(planes: Plane[], timeMs: number, focusId: string | null) {
    const dt = Math.min(0.1, (timeMs - lastMs) / 1000);
    lastMs = timeMs;
    head.quaternion.slerp(targetQ, HEAD_SMOOTHING);
    updateWorld(timeMs);

    for (const t of tracked.values()) t.seen = false;
    for (const p of planes) {
      const t = trackedFor(p, timeMs);
      t.seen = true;
      const { east, north } = toLocal(p.lat, p.lon);
      t.target.copy(enuToWorld(east, north, Math.max(0, (p.altitudeFt ?? 0) * FT) + 3));
      const g = t.model.group;
      if (g.position.lengthSq() === 0) g.position.copy(t.target);
      else g.position.lerp(t.target, 1 - Math.exp(-dt * POSITION_SMOOTHING));

      // Orientation: heading from track, nose pitch from climb, bank from turn rate.
      const trackDeg = p.trackDeg ?? 0;
      const gsMs = Math.max(1, (p.groundSpeedKt ?? 0) * 0.514444);
      const vsMs = ((p.verticalRateFpm ?? 0) * FT) / 60;
      if (t.lastTrack != null && dt > 0) {
        const turn = ((trackDeg - t.lastTrack + 540) % 360) - 180;
        const targetBank = THREE.MathUtils.clamp((turn / dt) * 0.6, -25, 25);
        t.bank += (targetBank - t.bank) * Math.min(1, dt * 2);
      }
      t.lastTrack = trackDeg;
      g.rotation.set(Math.atan2(vsMs, gsMs), THREE.MathUtils.degToRad(-trackDeg), THREE.MathUtils.degToRad(-t.bank), 'YXZ');

      // Keep aircraft visible at a distance: grow with range beyond TRUE_SCALE_RANGE_M.
      const dist = g.position.distanceTo(head.position);
      g.scale.setScalar(Math.max(MIN_SCALE, dist / TRUE_SCALE_RANGE_M));
      t.model.animate(timeMs);

      // Status halo (constant screen size), blinking for emergencies; focused aircraft in yellow.
      const status = aircraftStatus(p);
      const focused = p.id === focusId;
      const halo = t.halo.material as THREE.SpriteMaterial;
      halo.color.setHex(focused ? 0xffc94d : STATUS_HALO[status]);
      halo.opacity = status === 'emergency' && Math.floor(timeMs / 400) % 2 ? 0.15 : focused ? 0.9 : 0.55;
      t.halo.position.copy(g.position);
      t.halo.scale.setScalar(focused ? HALO_SIZE_FOCUSED : HALO_SIZE);

      // Trail: where it has been over the last ~45 s.
      if (timeMs - t.lastTrailMs >= TRAIL_SAMPLE_MS || t.trailPts.length === 0) {
        t.trailPts.push(g.position.clone());
        if (t.trailPts.length > TRAIL_POINTS) t.trailPts.shift();
        t.lastTrailMs = timeMs;
        const pos = t.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
        t.trailPts.forEach((v, k) => pos.setXYZ(k, v.x, v.y, v.z));
        pos.needsUpdate = true;
        t.trail.geometry.setDrawRange(0, t.trailPts.length);
        (t.trail.material as THREE.LineBasicMaterial).color.setHex(STATUS_HALO[status]);
      }
    }
    // Drop aircraft no longer in the feed.
    for (const [id, t] of tracked) {
      if (t.seen) continue;
      aircraftRoot.remove(t.model.group, t.halo, t.trail);
      t.trail.geometry.dispose();
      tracked.delete(id);
    }

    // Both eyes in one pass (viewport + scissor per half), then copy each half out.
    renderer.setScissorTest(true);
    cameras.forEach((cam, i) => {
      renderer.setViewport(i * eyeW, 0, eyeW, eyeH);
      renderer.setScissor(i * eyeW, 0, eyeW, eyeH);
      renderer.render(scene, cam);
    });
    renderer.setScissorTest(false);
    const src = renderer.domElement;
    const halfPx = Math.floor(src.width / 2);
    eyeCtxs.forEach((ctx, i) => ctx.drawImage(src, i * halfPx, 0, halfPx, src.height, 0, 0, halfPx, src.height));
  }

  resize();
  // Compile every shader up front so nothing pops in during the first frames (otherwise objects are
  // skipped until their shader is ready, and the ground shows through the rooftop for a moment).
  renderer.compile(scene, cameras[0]);
  return {
    halfTan,
    headingDeg,
    setDeviceRotation,
    setYawPitch,
    render,
    canvas: eyeCanvases[0],
    resize,
    stop() {
      renderer.dispose();
      eyeCanvases.forEach((c) => c.remove());
    },
  };
}
