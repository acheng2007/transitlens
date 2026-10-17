// The static VR scene: golden-hour sky, lush ground with trees ("city in a forest"), highways,
// ATL runways, the Atlanta skyline, and the Georgia Tech rooftop the viewer stands on.
// World: x = east, y = up, z = -north (meters).

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { ATL_RUNWAYS } from './scenario';
import { toLocal } from './local';

/** Viewer eye height: on a ~40 m campus rooftop. */
export const EYE_HEIGHT_M = 42;

/** Golden hour: low sun from the west-southwest (warm light, long glow, planes lit from the side). */
const SUN_ELEVATION_DEG = 11;
const SUN_AZIMUTH_DEG = 252;

/** Distance haze, tuned to the horizon color of the sky. */
const HAZE = new THREE.Color(0xe3d6c4);

export type World = {
  scene: THREE.Scene;
  /** Animate clouds. */
  update: (timeMs: number) => void;
};

/** Small deterministic PRNG so the scene is the same every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Cheap smooth 2D value noise in [0, 1], for ground color patches. */
function valueNoise(seed: number) {
  const hash = (x: number, y: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const s = (t: number) => t * t * (3 - 2 * t);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * s(xf) + (c - a) * s(yf) + (a - b - c + d) * s(xf) * s(yf);
  };
}

const world = (eastKm: number, northKm: number, y = 0) => new THREE.Vector3(eastKm * 1000, y, -northKm * 1000);

/** Places that should stay clear of trees and sprawl (km boxes: e1, e2, n1, n2). */
const CLEAR_ZONES: [number, number, number, number][] = [
  [-5.6, -0.3, -18.2, -13.0], // ATL airfield
  [-0.25, 0.25, -0.25, 0.25], // our rooftop
];
const inClearZone = (e: number, n: number) => CLEAR_ZONES.some(([e1, e2, n1, n2]) => e > e1 && e < e2 && n > n1 && n < n2);

function makeSky(sunDir: THREE.Vector3): Sky {
  const sky = new Sky();
  sky.scale.setScalar(250_000); // inside the cameras' 300 km far plane
  const u = sky.material.uniforms;
  u.turbidity.value = 5.5;
  u.rayleigh.value = 2.2;
  u.mieCoefficient.value = 0.006;
  u.mieDirectionalG.value = 0.86;
  u.cloudCoverage.value = 0.32;
  u.cloudDensity.value = 0.45;
  u.cloudElevation.value = 0.55;
  u.sunPosition.value.copy(sunDir);
  return sky;
}

export function createWorld(): World {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HAZE, 9_000, 85_000);

  const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEG);
  // Azimuth is clockwise from north; world north is -z.
  const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, Math.PI - theta);
  const sky = makeSky(sunDir);
  scene.add(sky);

  // Lighting: warm low sun + cool sky fill.
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x5b7a3a, 1.25));
  const sun = new THREE.DirectionalLight(0xffc98a, 3.2);
  sun.position.copy(sunDir).multiplyScalar(10_000);
  scene.add(sun);

  addGround(scene);
  addHighways(scene);
  addTrees(scene);
  addAirport(scene);
  addCity(scene);
  addRooftop(scene);

  return {
    scene,
    update(timeMs) {
      sky.material.uniforms.time.value = timeMs / 1000;
    },
  };
}

function addGround(scene: THREE.Scene) {
  // Far horizon ring, plus a detailed 70 km patch with vertex-colored greens (fields, woods, parks).
  // The horizon is a ring starting 34 km out, not a disc: a disc's fan triangles all meet under the
  // camera, and the log depth buffer gets their depth wrong near you (the ground drew over the
  // rooftop in some directions). Keep every big triangle far from the viewer.
  const far = new THREE.Mesh(
    new THREE.RingGeometry(34_000, 160_000, 96, 2),
    new THREE.MeshLambertMaterial({ color: 0x5f7f3c }),
  );
  far.rotation.x = -Math.PI / 2;
  far.position.y = -20; // under the detailed patch; only visible past 35 km
  far.name = 'groundFar';
  scene.add(far);

  const size = 70_000;
  const seg = 180;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  const noise = valueNoise(7);
  const colors: number[] = [];
  const c = new THREE.Color();
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / 1000;
    const y = pos.getY(i) / 1000;
    const n = noise(x * 0.35, y * 0.35) * 0.65 + noise(x * 1.7, y * 1.7) * 0.35;
    // Deep forest green to bright meadow, a little warmer in patches.
    c.setHSL(0.24 + n * 0.07, 0.5 + n * 0.15, 0.2 + n * 0.14);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.rotation.x = -Math.PI / 2;
  ground.name = 'groundPatch';
  scene.add(ground);
}

function addHighways(parent: THREE.Scene) {
  const scene = new THREE.Group();
  scene.name = 'highways';
  parent.add(scene);
  // Ground decals: lifted a few meters and polygon-offset so they don't z-fight with the ground at range.
  const road = new THREE.MeshLambertMaterial({ color: 0x3b3f46, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const strip = (e1: number, n1: number, e2: number, n2: number, widthM: number) => {
    const len = Math.hypot(e2 - e1, n2 - n1) * 1000;
    // Segmented (~400 m pieces): long thin triangles get bad depth with the log depth buffer.
    const m = new THREE.Mesh(new THREE.PlaneGeometry(widthM, len, 1, Math.max(1, Math.ceil(len / 400))), road);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -Math.atan2(e2 - e1, n2 - n1);
    m.position.copy(world((e1 + e2) / 2, (n1 + n2) / 2, 3));
    scene.add(m);
  };
  // Downtown Connector (I-75/85) just east of campus, north to south; I-20 east-west downtown;
  // I-285 perimeter as a rough ring.
  strip(0.45, 12, 0.7, 1.5, 70);
  strip(0.7, 1.5, 1.0, -3.2, 80);
  strip(1.0, -3.2, 0.2, -12, 70);
  strip(-14, -3.1, 14, -2.9, 60);
  const ringR = 17;
  for (let i = 0; i < 24; i++) {
    const a1 = (i / 24) * Math.PI * 2;
    const a2 = ((i + 1) / 24) * Math.PI * 2;
    strip(ringR * Math.sin(a1), -3 + ringR * Math.cos(a1), ringR * Math.sin(a2), -3 + ringR * Math.cos(a2), 50);
  }
}

function addTrees(scene: THREE.Scene) {
  // Atlanta is famously leafy: thousands of low-poly trees, denser close by for depth.
  const rand = rng(99);
  const count = 9_000;
  const canopy = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshLambertMaterial({ flatShading: true }),
    count,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let placed = 0;
  while (placed < count) {
    // Mix of near (0.1–1.5 km) and far (up to 14 km) trees.
    const near = rand() < 0.35;
    const r = near ? 0.1 + rand() * 1.4 : 0.8 + Math.pow(rand(), 0.8) * 13;
    const a = rand() * Math.PI * 2;
    const e = r * Math.sin(a);
    const n = r * Math.cos(a);
    if (inClearZone(e, n)) continue;
    // Keep downtown/midtown cores (towers) mostly clear.
    if (Math.hypot(e - 1.4, n + 2.6) < 0.8 || Math.hypot(e - 1.05, n - 1.05) < 0.55) continue;
    const h = 9 + rand() * 14;
    const w = h * (0.45 + rand() * 0.25);
    m.compose(world(e, n, h * 0.55), q.random(), new THREE.Vector3(w, h * 0.6, w));
    canopy.setMatrixAt(placed, m);
    canopy.setColorAt(placed, c.setHSL(0.25 + rand() * 0.08, 0.45 + rand() * 0.3, 0.17 + rand() * 0.14));
    placed++;
  }
  canopy.name = 'trees';
  scene.add(canopy);
}

function addAirport(scene: THREE.Scene) {
  // Airfield grass/apron area, then the five parallel runways with centerline dashes.
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(7_000, 5_200),
    new THREE.MeshLambertMaterial({ color: 0x8aa35f, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.copy(world(-2.9, -15.5, 4));
  scene.add(field);

  const asphalt = new THREE.MeshLambertMaterial({ color: 0x2e3034, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const paint = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
  const approach = new THREE.MeshBasicMaterial({ color: 0xffe3a0 });
  for (const [e1, e2, n] of ATL_RUNWAYS) {
    const len = (e2 - e1) * 1000;
    const rw = new THREE.Mesh(new THREE.PlaneGeometry(len, 60), asphalt);
    rw.rotation.x = -Math.PI / 2;
    rw.position.copy(world((e1 + e2) / 2, n, 8));
    scene.add(rw);
    for (let x = 30; x < len - 30; x += 90) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(40, 1.5), paint);
      dash.rotation.x = -Math.PI / 2;
      dash.position.copy(world(e1 + x / 1000, n, 11));
      scene.add(dash);
    }
    // Approach lights east of each threshold (arrivals come from the east).
    for (let i = 1; i <= 8; i++) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(7, 6, 4), approach);
      l.position.copy(world(e2 + i * 0.06, n, 6));
      scene.add(l);
    }
  }

  // Terminal buildings between the runway pairs, and a control tower.
  const concourse = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.4, metalness: 0.3 });
  for (let i = 0; i < 6; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(260, 22, 1_300), concourse);
    b.position.copy(world(-3.9 + i * 0.5, -14.8, 11));
    scene.add(b);
  }
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 120, 12), concourse);
  tower.position.copy(world(-2.2, -14.95, 60));
  const cab = new THREE.Mesh(
    new THREE.CylinderGeometry(16, 13, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0x28405c, metalness: 0.9, roughness: 0.1 }),
  );
  cab.position.copy(world(-2.2, -14.95, 126));
  scene.add(tower, cab);
}

function addCity(scene: THREE.Scene) {
  const rand = rng(42);
  type Cluster = { eastKm: number; northKm: number; radiusKm: number; count: number; minH: number; maxH: number };
  // Towers: downtown, midtown, Buckhead. Low-rise: scattered neighborhoods.
  const towers: Cluster[] = [
    { eastKm: 1.4, northKm: -2.6, radiusKm: 1.0, count: 75, minH: 50, maxH: 280 },
    { eastKm: 1.05, northKm: 1.05, radiusKm: 0.75, count: 55, minH: 40, maxH: 250 },
    { eastKm: 1.5, northKm: 8.5, radiusKm: 0.9, count: 35, minH: 40, maxH: 190 },
  ];
  const lowRise: Cluster[] = [{ eastKm: 0, northKm: 0, radiusKm: 11, count: 900, minH: 6, maxH: 22 }];

  const place = (clusters: Cluster[], mesh: THREE.InstancedMesh, colorFor: (h: number) => THREE.Color) => {
    const m = new THREE.Matrix4();
    let i = 0;
    for (const c of clusters) {
      for (let k = 0; k < c.count; k++) {
        const r = c.radiusKm * Math.sqrt(rand());
        const a = rand() * Math.PI * 2;
        const e = c.eastKm + r * Math.sin(a);
        const n = c.northKm + r * Math.cos(a);
        const h = c.minH + (c.maxH - c.minH) * Math.pow(rand(), 2.2);
        if (inClearZone(e, n)) {
          mesh.setMatrixAt(i++, new THREE.Matrix4().makeScale(0, 0, 0));
          continue;
        }
        const w = h > 60 ? 28 + rand() * 26 : 16 + rand() * 26;
        m.compose(world(e, n, h / 2), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 0.6), new THREE.Vector3(w, h, w * (0.7 + rand() * 0.6)));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, colorFor(h));
        i++;
      }
    }
    scene.add(mesh);
  };

  const box = new THREE.BoxGeometry(1, 1, 1);
  // Glass towers: shiny with a sun highlight and a faint sky-blue glow. (No environment map: building
  // one with PMREMGenerator broke depth for the rest of the scene with the log depth buffer.)
  const glass = new THREE.InstancedMesh(
    box,
    new THREE.MeshPhongMaterial({ specular: 0xa9c8e6, shininess: 70, emissive: 0x16304a, emissiveIntensity: 0.35 }),
    towers.reduce((n, c) => n + c.count, 0),
  );
  const glassColors = [0x5d8fbf, 0x7fb3c9, 0x9fc4d9, 0x3f6f8f, 0xc7d6e0, 0xd9b98c];
  glass.name = 'towers';
  place(towers, glass, () => new THREE.Color(glassColors[Math.floor(rand() * glassColors.length)]));

  // Warm brick/stone/stucco low-rise.
  const stone = new THREE.InstancedMesh(
    box,
    new THREE.MeshLambertMaterial(),
    lowRise.reduce((n, c) => n + c.count, 0),
  );
  stone.name = 'lowrise';
  place(lowRise, stone, () => new THREE.Color().setHSL(0.05 + rand() * 0.08, 0.25 + rand() * 0.25, 0.5 + rand() * 0.25));

  // Grady Memorial Hospital (the medevac's destination), with a red helipad cross.
  const grady = toLocal(33.7522, -84.3806);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(80, 45, 80), new THREE.MeshStandardMaterial({ color: 0xece5d8 }));
  pad.position.copy(world(grady.east / 1000, grady.north / 1000, 22));
  const h = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 1, 20), new THREE.MeshBasicMaterial({ color: 0xd21f2c }));
  h.position.copy(world(grady.east / 1000, grady.north / 1000, 46));
  scene.add(pad, h);
}

function addRooftop(scene: THREE.Scene) {
  // The rooftop you stand on: close-up geometry gives real stereo depth.
  const roofH = EYE_HEIGHT_M - 1.7;
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(24, roofH, 24),
    new THREE.MeshLambertMaterial({ color: 0xa89f92 }),
  );
  roof.position.set(0, roofH / 2, 0);
  roof.name = 'roof';
  scene.add(roof);
  const rail = new THREE.MeshStandardMaterial({ color: 0xc9a852, metalness: 0.8, roughness: 0.3 }); // GT gold
  for (const [x, z, w, d] of [
    [0, -12, 24, 0.12],
    [0, 12, 24, 0.12],
    [-12, 0, 0.12, 24],
    [12, 0, 0.12, 24],
  ]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), rail);
    bar.position.set(x, roofH + 1.05, z);
    scene.add(bar);
  }
  for (let k = -12; k <= 12; k += 3) {
    for (const [x, z] of [
      [k, -12],
      [k, 12],
      [-12, k],
      [12, k],
    ]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.05, 0.08), rail);
      post.position.set(x, roofH + 0.52, z);
      scene.add(post);
    }
  }
}
