// Plane data: the shared fixture (works with no backend) or Wesley's flight-service.

import fixture from '../../shared/fixtures/demo-planes.json';

/** Mirrors the `Plane` contract in CLAUDE.md. */
export type Plane = {
  id: string;
  callsign: string | null;
  registration: string | null;
  typeCode: string | null;
  typeName: string | null;
  airline: string | null;
  origin: string | null;
  destination: string | null;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  /** Vertical rate in ft/min (+ = climbing), from ADS-B baro_rate. Optional for older data. */
  verticalRateFpm?: number | null;
  distanceKm: number;
  bearingDeg: number;
  offsetDeg?: number;
  /** Raw ADS-B emitter category (e.g. "A3" large, "A7" rotorcraft). Optional for older data. */
  category?: string | null;
  /** 'helicopter' if category A7 or a known helicopter type; missing = treat as plane. */
  kind?: 'plane' | 'helicopter';
  /** Status flags from flight-service (optional so older data still loads). See CLAUDE.md. */
  onGround?: boolean;
  /** Emergency type ("general", "minfuel", "nordo", "unlawful", "downed"), null if none. */
  emergency?: string | null;
  military?: boolean;
  medical?: boolean;
};

export type LatLon = { lat: number; lon: number };

export type FlightsResponse = {
  center: LatLon;
  demo: boolean;
  fetchedAt: string;
  planes: Plane[];
};

export type FeedState = {
  planes: Plane[];
  /** Short human-readable status for the debug line, e.g. "fixture" or "live · offline". */
  status: string;
};

export type PlaneFeed = {
  get: () => FeedState;
  stop: () => void;
};

const FIXTURE = fixture as unknown as FlightsResponse;
export const FIXTURE_CENTER: LatLon = FIXTURE.center;

/** Planes within `radiusKm` (all of them if null). */
function withinRadius(planes: Plane[], radiusKm: number | null): Plane[] {
  return radiusKm == null ? planes : planes.filter((p) => p.distanceKm <= radiusKm);
}

/** Static planes from shared/fixtures/demo-planes.json. Bearings are relative to the fixture center. */
export function startFixtureFeed(radiusKm: number | null = null): PlaneFeed {
  const state: FeedState = { planes: withinRadius(FIXTURE.planes, radiusKm), status: 'fixture' };
  return { get: () => state, stop: () => {} };
}

const POLL_MS = 1000;

/**
 * Polls GET /api/flights/nearby. Sends `radiusKm` only if the user set one on the start screen;
 * otherwise flight-service's defaults apply. Always asks for fovDeg=360: the web app does the per-frame
 * cone filter itself (labels, off-screen arrows), so it needs every plane in range.
 * On failure it keeps showing the last good data. In demo mode, if the service has never
 * answered, it shows the fixture (same demo location) so the sky is never empty on stage.
 */
export function startLiveFeed(opts: {
  demo: boolean;
  /** null = let flight-service pick (15 km live, 40 km demo). */
  radiusKm: number | null;
  getPosition: () => LatLon | null;
  getHeading: () => number | null;
}): PlaneFeed {
  const state: FeedState = { planes: [], status: 'live · connecting' };
  let stopped = false;
  let timer = 0;

  async function poll() {
    const pos = opts.demo ? FIXTURE_CENTER : opts.getPosition();
    if (!pos) {
      state.status = 'live · waiting for GPS';
    } else {
      const params = new URLSearchParams({
        lat: pos.lat.toFixed(5),
        lon: pos.lon.toFixed(5),
        fovDeg: '360',
        demo: opts.demo ? '1' : '0',
      });
      const heading = opts.getHeading();
      if (heading != null) params.set('heading', heading.toFixed(1));
      if (opts.radiusKm != null) params.set('radiusKm', String(opts.radiusKm));
      try {
        const res = await fetch(`/api/flights/nearby?${params}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as FlightsResponse;
        state.planes = data.planes;
        state.status = `live${data.demo ? ' demo' : ''} · ${data.planes.length} planes`;
      } catch {
        if (opts.demo && state.planes.length === 0) {
          state.planes = withinRadius(FIXTURE.planes, opts.radiusKm);
          state.status = 'service offline · showing fixture';
        } else {
          state.status = `service offline · ${state.planes.length} cached`;
        }
      }
    }
    if (!stopped) timer = window.setTimeout(poll, POLL_MS);
  }

  poll();
  return {
    get: () => state,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** Continuous GPS position, or null until the first fix. */
export function watchPosition(): { get: () => LatLon | null; stop: () => void } {
  let pos: LatLon | null = null;
  if (!navigator.geolocation) return { get: () => null, stop: () => {} };
  const id = navigator.geolocation.watchPosition(
    (p) => (pos = { lat: p.coords.latitude, lon: p.coords.longitude }),
    () => {},
    { enableHighAccuracy: true, maximumAge: 10_000 },
  );
  return { get: () => pos, stop: () => navigator.geolocation.clearWatch(id) };
}
