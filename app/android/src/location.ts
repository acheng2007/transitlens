// Native transit location tracking and geomagnetic model updates.

import type { Position } from '@web/buses';

export type GpsWatch = { get: () => Position | null; status: () => string; stop: () => void };

/**
 * null until the first fix. Location permission is requested separately (native.ts).
 * `onFix` runs on every position update (e.g. to look up the local magnetic declination).
 */
export function watchPosition(onFix?: (pos: Position) => void): GpsWatch {
  let pos: Position | null = null;
  let status = 'Waiting for GPS';
  if (!navigator.geolocation) return { get: () => null, status: () => 'Geolocation unavailable', stop: () => {} };
  const id = navigator.geolocation.watchPosition(
    (p) => {
      pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      status = p.coords.accuracy > 100 ? `GPS accuracy ±${Math.round(p.coords.accuracy)} m` : '';
      onFix?.(pos);
    },
    error => { status = error.code === 1 ? 'GPS permission denied - enable location and restart' : 'GPS unavailable - waiting for a fix'; },
    { enableHighAccuracy: true, maximumAge: 10_000 },
  );
  return { get: () => pos, status: () => status, stop: () => navigator.geolocation.clearWatch(id) };
}
