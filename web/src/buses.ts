import type { Bus, BusesResponse } from '../../shared/transit';
import { signedDiffDeg, haversineKm, bearingDeg } from './geo';
export type { Bus } from '../../shared/transit';

/** Fixed public location, used only by explicitly labeled desktop development mode. */
export const REITZ_CENTER = { lat: 29.6465, lon: -82.3478 };
export type Position = typeof REITZ_CENTER;
export type BusFeed = { get: () => { buses: Bus[]; status: string; declinationDeg: number | null; position: Position | null; responseCenter: Position | null }; stop: () => void };

export function watchPosition() {
  let position: Position | null = null;
  let status = 'Waiting for GPS';
  const id = navigator.geolocation?.watchPosition(
    (p) => {
      position = { lat: p.coords.latitude, lon: p.coords.longitude };
      status = p.coords.accuracy > 100 ? `GPS accuracy ±${Math.round(p.coords.accuracy)} m` : '';
    },
    (e) => { status = e.code === 1 ? 'GPS permission denied - enable location and restart' : 'GPS unavailable - waiting for a fix'; },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
  );
  if (!navigator.geolocation) status = 'Geolocation unavailable';
  return { get: () => position, status: () => status, stop: () => { if (id != null) navigator.geolocation.clearWatch(id); } };
}

export function startBusFeed(opts: { getPosition: () => Position | null; positionStatus: () => string; radiusKm: number; endpoint?: string }): BusFeed {
  const state = { buses: [] as Bus[], status: 'Connecting to Live RTS', declinationDeg: null as number | null };
  let fetchedAt: string | null = null;
  let responseCenter: Position | null = null;
  let stopped = false;
  let timer = 0;
  let controller: AbortController | null = null;
  async function poll() {
    const pos = opts.getPosition();
    if (!pos) state.status = '';
    else {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 45000);
      try {
        const params = new URLSearchParams({ lat: String(pos.lat), lon: String(pos.lon), radiusKm: String(opts.radiusKm), fovDeg: '360' });
        const res = await fetch(`${opts.endpoint ?? '/api/buses/nearby'}?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error('Bus service unavailable');
        const data = await res.json() as BusesResponse;
        if (!Array.isArray(data.buses) || !['available', 'stale', 'unavailable'].includes(data.status) || data.demo !== false) throw new Error('Invalid bus response');
        if (stopped) return;
        state.declinationDeg = Number.isFinite(data.magneticDeclinationDeg) ? data.magneticDeclinationDeg : null;
        if (data.status !== 'unavailable') { state.buses = data.buses; fetchedAt = data.fetchedAt; responseCenter = data.center; }
        state.status = data.status === 'available' ? (data.buses.length ? `Live RTS · ${data.buses.length} buses` : 'No nearby buses') : 'LIVE DATA TEMPORARILY UNAVAILABLE';
      } catch {
        if (!stopped) state.status = 'LIVE DATA TEMPORARILY UNAVAILABLE';
      } finally { clearTimeout(timeout); }
    }
    if (!stopped) timer = window.setTimeout(poll, pos ? 10000 : 1000);
  }
  void poll();
  return {
    get: () => {
      const positionStatus = opts.positionStatus();
      const age = fetchedAt ? ` · data ${Math.max(0, Math.floor((Date.now() - Date.parse(fetchedAt)) / 1000))}s old` : '';
      const position = opts.getPosition();
      return { position, responseCenter, buses: position ? relativeBuses(state.buses, position) : state.buses, declinationDeg: state.declinationDeg, status: [positionStatus, `${state.status}${age}`].filter(Boolean).join(' · ') };
    },
    stop: () => { stopped = true; clearTimeout(timer); controller?.abort(); },
  };
}

/** How long a bus must stay in the focus cone before its card opens. */
const DWELL_MS = 650;

/** One dwell calculation per frame; rendering never changes selection. */
export function createBusFocus() {
  let candidate: string | null = null;
  let since = 0;
  return {
    update(buses: Bus[], heading: number | null, time: number): string | null {
      const next = heading == null ? null : buses
        .filter(b => Math.abs(signedDiffDeg(b.bearingDeg, heading)) <= 7.5)
        .sort((a, b) => Math.abs(signedDiffDeg(a.bearingDeg, heading)) - Math.abs(signedDiffDeg(b.bearingDeg, heading)) || a.distanceKm - b.distanceKm)[0]?.id ?? null;
      if (next !== candidate) { candidate = next; since = time; }
      return candidate && time - since >= DWELL_MS ? candidate : null;
    },
    /** Read-only dwell progress (0..1) of the current candidate, for the HUD's selection ring. */
    progress(time: number): { id: string | null; t: number } {
      return { id: candidate, t: candidate ? Math.min(1, Math.max(0, (time - since) / DWELL_MS)) : 0 };
    },
  };
}

/** Rebase every feed read to the current GPS, including cached vehicles. */
export function relativeBuses(buses: Bus[], position: Position): Bus[] {
  return buses.map(b => ({ ...b, distanceKm: haversineKm(position.lat, position.lon, b.lat, b.lon), bearingDeg: bearingDeg(position.lat, position.lon, b.lat, b.lon) }));
}
