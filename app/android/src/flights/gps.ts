// Continuous GPS position for live mode (same as watchPosition in web/src/planes.ts, which can't be
// imported at runtime without also bundling the web fixture).

import type { LatLon } from '@web/planes';

export type GpsWatch = { get: () => LatLon | null; stop: () => void };

/**
 * null until the first fix. Location permission is requested separately (native.ts).
 * `onFix` runs on every position update (e.g. to look up the local magnetic declination).
 */
export function watchPosition(onFix?: (pos: LatLon) => void): GpsWatch {
  let pos: LatLon | null = null;
  if (!navigator.geolocation) return { get: () => null, stop: () => {} };
  const id = navigator.geolocation.watchPosition(
    (p) => {
      pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      onFix?.(pos);
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10_000 },
  );
  return { get: () => pos, stop: () => navigator.geolocation.clearWatch(id) };
}
