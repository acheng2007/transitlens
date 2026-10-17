// Flat local coordinates around the viewer (Georgia Tech). Within ~50 km the flat-earth error
// is negligible for this demo. east/north in meters; Three.js world is x = east, y = up, z = -north.

export const ORIGIN = { lat: 33.7756, lon: -84.3963 };

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export const FT = 0.3048;
export const KT = 0.514444; // m/s per knot

export function toLocal(lat: number, lon: number): { east: number; north: number } {
  return { east: (lon - ORIGIN.lon) * M_PER_DEG_LON, north: (lat - ORIGIN.lat) * M_PER_DEG_LAT };
}

export function fromLocal(east: number, north: number): { lat: number; lon: number } {
  return { lat: ORIGIN.lat + north / M_PER_DEG_LAT, lon: ORIGIN.lon + east / M_PER_DEG_LON };
}

/** Bearing (deg, clockwise from north) and distance (km) from the viewer to a local point. */
export function bearingDistance(east: number, north: number): { bearingDeg: number; distanceKm: number } {
  const b = (Math.atan2(east, north) * 180) / Math.PI;
  return { bearingDeg: (b + 360) % 360, distanceKm: Math.hypot(east, north) / 1000 };
}
