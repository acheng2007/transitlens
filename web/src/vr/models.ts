// Low-poly aircraft built from primitives (no model files to load). Units: meters.
// Every model faces -Z (north when unrotated), +Y up, +X = its right wing.

import * as THREE from 'three';

export type AircraftModel = {
  group: THREE.Group;
  /** Called every frame: blinking lights, spinning rotor. */
  animate: (timeMs: number) => void;
};

const WHITE = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.45, metalness: 0.15 });
const GREY = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.6, metalness: 0.2 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.3 });
const GLASS = new THREE.MeshStandardMaterial({ color: 0x1d2a3a, roughness: 0.1, metalness: 0.6 });

/** Tail colors by airline (fallback: neutral blue). */
const AIRLINE_TAIL: Record<string, number> = {
  'Delta Air Lines': 0xc8102e,
  'Southwest Airlines': 0x304cb2,
  'American Airlines': 0x9da6ab,
  'United Airlines': 0x005daa,
  'Frontier Airlines': 0x1f7a3a,
  'Endeavor Air': 0xc8102e,
};

function light(color: number, size: number): THREE.Mesh {
  // Unlit, so nav lights stay bright regardless of the sun.
  return new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), new THREE.MeshBasicMaterial({ color }));
}

/** Blink helper: on for `onMs` every `periodMs`, offset per aircraft so they don't flash in sync. */
function blink(timeMs: number, periodMs: number, onMs: number, offsetMs: number): boolean {
  return (timeMs + offsetMs) % periodMs < onMs;
}

export function createAirliner(opts: { airline: string | null; military?: boolean; size?: number; seed: number }): AircraftModel {
  const s = opts.size ?? 1; // 1 = ~A320 (37 m long, 34 m span)
  const body = opts.military ? GREY : WHITE;
  const tailMat = opts.military
    ? GREY
    : new THREE.MeshStandardMaterial({ color: AIRLINE_TAIL[opts.airline ?? ''] ?? 0x3a6ea5, roughness: 0.5 });
  const g = new THREE.Group();

  // Fuselage along Z (cylinders are built along Y, so rotate them).
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(2 * s, 2 * s, 30 * s, 14), body);
  fuselage.rotation.x = Math.PI / 2;
  g.add(fuselage);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(2 * s, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), body);
  nose.rotation.x = -Math.PI / 2;
  nose.scale.set(1, 1.6, 1);
  nose.position.z = -15 * s;
  g.add(nose);
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(2.6 * s, 0.8 * s, 1.6 * s), GLASS);
  cockpit.position.set(0, 1.1 * s, -16 * s);
  g.add(cockpit);
  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(2 * s, 7 * s, 14), body);
  tailCone.rotation.x = Math.PI / 2;
  tailCone.position.z = 18.5 * s;
  g.add(tailCone);

  // Swept wings (military: high-mounted like a C-17).
  const wingY = opts.military ? 1.6 * s : -0.8 * s;
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(16 * s, 0.5 * s, 5 * s), body);
    wing.position.set(side * 9.5 * s, wingY, 1.5 * s);
    wing.rotation.y = side * -0.35;
    g.add(wing);
    const engine = new THREE.Mesh(new THREE.CylinderGeometry(1.1 * s, 1.1 * s, 4 * s, 12), DARK);
    engine.rotation.x = Math.PI / 2;
    engine.position.set(side * 6 * s, wingY - 1.4 * s, -1 * s);
    g.add(engine);
    if (opts.military) {
      const outer = engine.clone();
      outer.position.x = side * 11 * s;
      outer.position.z = 1 * s;
      g.add(outer);
    }
  }

  // Tail: vertical fin (airline color) + horizontal stabilizers.
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5 * s, 7 * s, 5 * s), tailMat);
  fin.position.set(0, 4.5 * s, 17 * s);
  fin.rotation.x = -0.3;
  g.add(fin);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(12 * s, 0.35 * s, 3 * s), body);
  stab.position.set(0, opts.military ? 7.5 * s : 0.8 * s, 18.5 * s);
  g.add(stab);

  // Nav lights: red left wingtip, green right, white strobes, red beacon on top.
  const red = light(0xff2020, 0.7 * s);
  red.position.set(-17.5 * s, wingY, 4.5 * s);
  const green = light(0x20ff40, 0.7 * s);
  green.position.set(17.5 * s, wingY, 4.5 * s);
  const strobeL = light(0xffffff, 0.9 * s);
  strobeL.position.copy(red.position);
  const strobeR = light(0xffffff, 0.9 * s);
  strobeR.position.copy(green.position);
  const beacon = light(0xff3030, 0.8 * s);
  beacon.position.set(0, 2.3 * s, 2 * s);
  g.add(red, green, strobeL, strobeR, beacon);

  const offset = (opts.seed * 377) % 1000;
  return {
    group: g,
    animate(timeMs) {
      const strobe = blink(timeMs, 1100, 80, offset);
      strobeL.visible = strobeR.visible = strobe;
      beacon.visible = blink(timeMs, 1300, 250, offset + 500);
    },
  };
}

export function createHelicopter(opts: { medical?: boolean; seed: number }): AircraftModel {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: opts.medical ? 0xf4f4f4 : 0x2f5d8a, roughness: 0.4 });
  const stripe = new THREE.MeshStandardMaterial({ color: opts.medical ? 0xd21f2c : 0xf2c14e, roughness: 0.5 });

  const cabin = new THREE.Mesh(new THREE.SphereGeometry(1.6, 14, 10), paint);
  cabin.scale.set(1, 1, 1.9);
  g.add(cabin);
  const glass = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), GLASS);
  glass.rotation.x = -Math.PI / 2 - 0.4;
  glass.position.set(0, 0.3, -2);
  g.add(glass);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1.62, 1.62, 0.5, 14), stripe);
  band.rotation.x = Math.PI / 2;
  band.position.z = 0.6;
  g.add(band);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, 7, 8), paint);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 0.4, 5.8);
  g.add(boom);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.2, 1.2), stripe);
  fin.position.set(0, 1.2, 9);
  g.add(fin);
  for (const side of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 5), DARK);
    skid.position.set(side * 1.2, -2, 0);
    g.add(skid);
  }

  const rotor = new THREE.Group();
  for (const a of [0, Math.PI / 2]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(11, 0.08, 0.35), DARK);
    blade.rotation.y = a;
    rotor.add(blade);
  }
  rotor.position.y = 1.9;
  g.add(rotor);
  const tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2, 0.25), DARK);
  tailRotor.position.set(0.3, 1.2, 9.2);
  g.add(tailRotor);

  const beacon = light(0xff3030, 0.35);
  beacon.position.set(0, 1.7, 2);
  g.add(beacon);
  const offset = (opts.seed * 211) % 1000;
  return {
    group: g,
    animate(timeMs) {
      rotor.rotation.y = timeMs * 0.03;
      tailRotor.rotation.x = timeMs * 0.06;
      beacon.visible = blink(timeMs, 1000, 200, offset);
    },
  };
}
