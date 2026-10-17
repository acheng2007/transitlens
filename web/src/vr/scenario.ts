// Scripted, looping ATC scenario over Atlanta for the VR demo (fake data, same `Plane` shape as
// flight-service, so the HUD, radar, cards and Grok all work unchanged).
//
// Geometry (km, relative to the viewer at Georgia Tech; +east, +north). ATL is ~15 km south.
// West flow: arrivals land westbound on 26R / 27L from the east, departures roll west off 27R / 26L.
// Runway positions are approximate.

import type { Plane, PlaneFeed } from '../planes';
import { KT, bearingDistance, fromLocal } from './local';

/** Waypoint: position in km, altitude in ft, ground speed in kt at that point. */
type Wp = [eastKm: number, northKm: number, altFt: number, speedKt: number];

type Route = {
  name: string;
  path: Wp[];
  /** Loop the path back to its start (circuits) instead of restarting from the first waypoint. */
  closed?: boolean;
};

type Flight = {
  id: string;
  route: Route;
  /** 0..1: where on its route this flight is at t = 0 (spreads a stream of flights out). */
  phase: number;
  callsign: string | null;
  registration: string | null;
  typeCode: string;
  typeName: string;
  airline: string | null;
  origin: string | null;
  destination: string | null;
  kind?: 'plane' | 'helicopter';
  category?: string;
  military?: boolean;
  medical?: boolean;
  /** Declares an emergency once it's this far (0..1) along its route. */
  emergencyAt?: { progress: number; type: string };
};

// ---- Routes ------------------------------------------------------------------------------------

// ATL runway centerlines (north offset, km) and the east end (threshold for westbound landings).
const RWY_26R = -13.9;
const RWY_26L = -14.24;
const RWY_27R = -15.36;
const RWY_27L = -15.66;

const ARRIVAL_26R: Route = {
  name: 'arrival 26R',
  path: [
    [38, 8, 11000, 280],
    [24, RWY_26R, 4200, 190],
    [-0.9, RWY_26R, 60, 140],
    [-3.2, RWY_26R, 0, 30],
  ],
};

const ARRIVAL_27L: Route = {
  name: 'arrival 27L',
  path: [
    [40, -34, 11000, 280],
    [24, RWY_27L, 4200, 190],
    [-1.6, RWY_27L, 60, 140],
    [-4.0, RWY_27L, 0, 30],
  ],
};

const DEPARTURE_WEST: Route = {
  name: 'departure 27R west',
  path: [
    [-1.6, RWY_27R, 0, 20],
    [-4.4, RWY_27R, 0, 160],
    [-16, RWY_27R, 5000, 230],
    [-32, 6, 13000, 300],
    [-44, 32, 20000, 360],
  ],
};

const DEPARTURE_NORTH: Route = {
  name: 'departure 26L north',
  path: [
    [-0.9, RWY_26L, 0, 20],
    [-3.8, RWY_26L, 0, 160],
    [-13, RWY_26L, 4500, 230],
    [-11, 4, 9000, 280],
    [4, 34, 16000, 330],
  ],
};

const OVERFLIGHT: Route = {
  name: 'overflight',
  path: [
    [-48, -30, 35000, 460],
    [48, 36, 35000, 460],
  ],
};

const C17_LOW_PASS: Route = {
  name: 'C-17 low pass',
  path: [
    [-38, 3, 3000, 250],
    [38, 3, 3000, 250],
  ],
};

// Grady Memorial Hospital downtown (~1.45 km E, 2.6 km S of GT).
const MEDEVAC: Route = {
  name: 'medevac to Grady',
  path: [
    [-14, 9, 1500, 125],
    [-3, 2, 1200, 120],
    [1.45, -2.6, 400, 40],
    [1.45, -2.6, 350, 0.1],
    [9, -10, 1400, 125],
    [22, -6, 1500, 125],
  ],
};

// Cessna circuits around DeKalb-Peachtree (PDK, ~8.7 km E, 11 km N).
const PDK_PATTERN: Route = {
  name: 'PDK pattern',
  closed: true,
  path: Array.from({ length: 12 }, (_, i): Wp => {
    const a = (i / 12) * Math.PI * 2;
    return [8.7 + 2.2 * Math.sin(a), 11.1 + 1.4 * Math.cos(a), 2000 + 300 * Math.sin(a * 2), 95];
  }),
};

// ---- Flights -----------------------------------------------------------------------------------

const FLIGHTS: Flight[] = [
  { id: 'sim01', route: ARRIVAL_26R, phase: 0.05, callsign: 'DAL1234', registration: 'N301DN', typeCode: 'A321', typeName: 'Airbus A321-200', airline: 'Delta Air Lines', origin: 'LGA', destination: 'ATL', category: 'A3' },
  { id: 'sim02', route: ARRIVAL_26R, phase: 0.38, callsign: 'SWA2291', registration: 'N8710M', typeCode: 'B38M', typeName: 'Boeing 737 MAX 8', airline: 'Southwest Airlines', origin: 'BWI', destination: 'ATL', category: 'A3' },
  { id: 'sim03', route: ARRIVAL_26R, phase: 0.71, callsign: 'DAL441', registration: 'N411DZ', typeCode: 'A359', typeName: 'Airbus A350-900', airline: 'Delta Air Lines', origin: 'CDG', destination: 'ATL', category: 'A5' },
  {
    id: 'sim04', route: ARRIVAL_27L, phase: 0.2, callsign: 'DAL1776', registration: 'N903DE', typeCode: 'B739', typeName: 'Boeing 737-900ER', airline: 'Delta Air Lines', origin: 'MCO', destination: 'ATL', category: 'A3',
    emergencyAt: { progress: 0.3, type: 'general' },
  },
  { id: 'sim05', route: ARRIVAL_27L, phase: 0.53, callsign: 'AAL1561', registration: 'N417AN', typeCode: 'A21N', typeName: 'Airbus A321neo', airline: 'American Airlines', origin: 'DFW', destination: 'ATL', category: 'A3' },
  { id: 'sim06', route: ARRIVAL_27L, phase: 0.86, callsign: 'EDV5037', registration: 'N917XJ', typeCode: 'CRJ9', typeName: 'Bombardier CRJ900', airline: 'Endeavor Air', origin: 'CHA', destination: 'ATL', category: 'A2' },
  { id: 'sim07', route: DEPARTURE_WEST, phase: 0.1, callsign: 'DAL88', registration: 'N826NW', typeCode: 'A333', typeName: 'Airbus A330-300', airline: 'Delta Air Lines', origin: 'ATL', destination: 'LAX', category: 'A5' },
  { id: 'sim08', route: DEPARTURE_WEST, phase: 0.6, callsign: 'FFT1702', registration: 'N705FR', typeCode: 'A20N', typeName: 'Airbus A320neo', airline: 'Frontier Airlines', origin: 'ATL', destination: 'DEN', category: 'A3' },
  { id: 'sim09', route: DEPARTURE_NORTH, phase: 0.3, callsign: 'DAL2517', registration: 'N6711M', typeCode: 'B752', typeName: 'Boeing 757-200', airline: 'Delta Air Lines', origin: 'ATL', destination: 'BOS', category: 'A4' },
  { id: 'sim10', route: DEPARTURE_NORTH, phase: 0.8, callsign: 'UAL1580', registration: 'N37502', typeCode: 'B38M', typeName: 'Boeing 737 MAX 8', airline: 'United Airlines', origin: 'ATL', destination: 'ORD', category: 'A3' },
  { id: 'sim11', route: OVERFLIGHT, phase: 0.45, callsign: 'UAL2', registration: 'N29975', typeCode: 'B789', typeName: 'Boeing 787-9', airline: 'United Airlines', origin: 'IAH', destination: 'LGA', category: 'A5' },
  { id: 'sim12', route: C17_LOW_PASS, phase: 0.15, callsign: 'RCH871', registration: '07-7179', typeCode: 'C17', typeName: 'Boeing C-17 Globemaster III', airline: null, origin: null, destination: null, category: 'A5', military: true },
  { id: 'sim13', route: MEDEVAC, phase: 0.1, callsign: 'LIFE12', registration: 'N445CH', typeCode: 'EC45', typeName: 'Airbus H145', airline: null, origin: null, destination: 'Grady Memorial', kind: 'helicopter', category: 'A7', medical: true },
  { id: 'sim14', route: PDK_PATTERN, phase: 0, callsign: 'N172GT', registration: 'N172GT', typeCode: 'C172', typeName: 'Cessna 172 Skyhawk', airline: null, origin: 'PDK', destination: 'PDK', category: 'A1' },
];

// ---- Route timing ------------------------------------------------------------------------------

type Segment = { from: Wp; to: Wp; lengthM: number; durationS: number; startS: number };
type Timed = { segments: Segment[]; totalS: number };

function timeRoute(route: Route): Timed {
  const pts = route.closed ? [...route.path, route.path[0]] : route.path;
  const segments: Segment[] = [];
  let t = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [e1, n1] = pts[i];
    const [e2, n2] = pts[i + 1];
    const lengthM = Math.hypot(e2 - e1, n2 - n1) * 1000;
    const avgSpeed = Math.max(1, ((pts[i][3] + pts[i + 1][3]) / 2) * KT);
    // Zero-length hover/pause segments hold for a few seconds.
    const durationS = lengthM < 1 ? 8 : lengthM / avgSpeed;
    segments.push({ from: pts[i], to: pts[i + 1], lengthM, durationS, startS: t });
    t += durationS;
  }
  return { segments, totalS: t };
}

const TIMED = new Map<Route, Timed>();
for (const f of FLIGHTS) if (!TIMED.has(f.route)) TIMED.set(f.route, timeRoute(f.route));

/** Position/altitude/speed on a route at time `s` into it. */
function sample(timed: Timed, s: number): { east: number; north: number; altFt: number; speedKt: number; seg: Segment } {
  const seg = timed.segments.find((g) => s < g.startS + g.durationS) ?? timed.segments[timed.segments.length - 1];
  const u = Math.min(1, Math.max(0, (s - seg.startS) / seg.durationS));
  const lerp = (a: number, b: number) => a + (b - a) * u;
  return {
    east: lerp(seg.from[0], seg.to[0]) * 1000,
    north: lerp(seg.from[1], seg.to[1]) * 1000,
    altFt: lerp(seg.from[2], seg.to[2]),
    speedKt: lerp(seg.from[3], seg.to[3]),
    seg,
  };
}

function flightAt(f: Flight, tS: number): Plane {
  const timed = TIMED.get(f.route)!;
  const s = (((tS / timed.totalS + f.phase) % 1) + 1) % 1 * timed.totalS;
  const now = sample(timed, s);
  const next = sample(timed, Math.min(timed.totalS, s + 1));
  const dE = now.seg.to[0] - now.seg.from[0];
  const dN = now.seg.to[1] - now.seg.from[1];
  const trackDeg = dE === 0 && dN === 0 ? 0 : ((Math.atan2(dE, dN) * 180) / Math.PI + 360) % 360;
  const { lat, lon } = fromLocal(now.east, now.north);
  const { bearingDeg, distanceKm } = bearingDistance(now.east, now.north);
  const progress = s / timed.totalS;
  const onGround = now.altFt <= 1;
  return {
    id: f.id,
    callsign: f.callsign,
    registration: f.registration,
    typeCode: f.typeCode,
    typeName: f.typeName,
    airline: f.airline,
    origin: f.origin,
    destination: f.destination,
    lat,
    lon,
    altitudeFt: Math.round(now.altFt),
    groundSpeedKt: Math.round(now.speedKt),
    trackDeg: Math.round(trackDeg),
    verticalRateFpm: Math.round((next.altFt - now.altFt) * 60),
    distanceKm: Math.round(distanceKm * 1000) / 1000,
    bearingDeg: Math.round(bearingDeg * 100) / 100,
    category: f.category ?? null,
    kind: f.kind ?? 'plane',
    onGround,
    emergency: f.emergencyAt && progress >= f.emergencyAt.progress ? f.emergencyAt.type : null,
    military: f.military ?? false,
    medical: f.medical ?? false,
  };
}

/** Scenario clock: 1.0 = real time. */
const SIM_SPEED = 1;
/**
 * The scenario starts this far in, at a moment where the story is already set up: DAL1776 has
 * declared its 7700 emergency and traffic is spread across the sky. A frozen scene shows this moment.
 */
const SIM_START_S = 90;

/** Data feed for the scripted scenario ('sim' data mode). Recomputed on every read, so motion is smooth. */
export function startSimFeed(): PlaneFeed {
  const t0 = performance.now();
  return {
    get: () => {
      const tS = SIM_START_S + ((performance.now() - t0) / 1000) * SIM_SPEED;
      return { planes: FLIGHTS.map((f) => flightAt(f, tS)), status: 'simulation' };
    },
    stop: () => {},
  };
}

/** For scene building: runway centerlines [east1Km, east2Km, northKm]. */
export const ATL_RUNWAYS: [number, number, number][] = [
  [-3.86, -0.92, RWY_26R],
  [-3.86, -0.92, RWY_26L],
  [-4.79, -1.6, RWY_27R],
  [-4.79, -1.6, RWY_27L],
  [-4.83, -1.73, -17.17],
];
