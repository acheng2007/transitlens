// Port of flight-service/app/normalize.py: readsb aircraft -> contract `Plane` (see CLAUDE.md).

import type { Plane } from '@web/planes';
import { bearingDeg, haversineKm } from './geo';
import {
  AIRLINES,
  DBFLAG_MILITARY,
  EMERGENCY_SQUAWKS,
  EMERGENCY_STATUSES,
  HELICOPTER_TYPES,
  MEDICAL_CALLSIGN_PREFIXES,
  TYPE_NAMES,
} from './tables';

/** One aircraft as adsb.lol returns it (readsb JSON: hex, flight, r, t, lat, lon, alt_baro, ...). */
export type RawAircraft = Record<string, unknown>;

/** Trimmed string field, '' if missing or not a string. */
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const round = (v: number, decimals: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;

/** 'helicopter' if the ADS-B emitter category is A7 (rotorcraft) or the type is a known helicopter. */
function kind(category: string | null, typeCode: string | null): 'plane' | 'helicopter' {
  return category === 'A7' || (typeCode != null && HELICOPTER_TYPES.has(typeCode)) ? 'helicopter' : 'plane';
}

function emergency(ac: RawAircraft): string | null {
  const status = str(ac.emergency).toLowerCase();
  if (EMERGENCY_STATUSES.has(status)) return status;
  const squawk = ac.squawk == null ? '' : String(ac.squawk).trim();
  return EMERGENCY_SQUAWKS[squawk] ?? null;
}

function medical(ac: RawAircraft, callsign: string | null): boolean {
  if (str(ac.emergency).toLowerCase() === 'lifeguard') return true;
  const cs = callsign?.toUpperCase() ?? '';
  return MEDICAL_CALLSIGN_PREFIXES.some((prefix) => cs.startsWith(prefix));
}

function military(ac: RawAircraft): boolean {
  const flags = ac.dbFlags;
  return Number.isInteger(flags) && ((flags as number) & DBFLAG_MILITARY) !== 0;
}

export function normalize(ac: RawAircraft, centerLat: number, centerLon: number): Plane | null {
  const lat = num(ac.lat);
  const lon = num(ac.lon);
  if (lat == null || lon == null) return null;

  const callsign = str(ac.flight) || null;
  const typeCode = str(ac.t).toUpperCase() || null;
  const category = str(ac.category).toUpperCase() || null;
  const alt = ac.alt_baro;
  const altitudeFt = alt === 'ground' ? 0 : num(alt);
  // ft/min, + = climbing. baro_rate is the common one; geom_rate (GPS) as fallback.
  const verticalRateFpm = num(ac.baro_rate) ?? num(ac.geom_rate);

  let airline: string | null = null;
  if (callsign && /^[A-Za-z]{3}\d/.test(callsign)) {
    airline = AIRLINES[callsign.slice(0, 3).toUpperCase()] ?? null;
  }

  return {
    id: str(ac.hex).replace(/^~+/, '').toLowerCase(),
    callsign,
    registration: str(ac.r) || null,
    typeCode,
    typeName: typeCode ? (TYPE_NAMES[typeCode] ?? null) : null,
    category,
    kind: kind(category, typeCode),
    onGround: alt === 'ground',
    emergency: emergency(ac),
    military: military(ac),
    medical: medical(ac, callsign),
    airline,
    origin: null,
    destination: null,
    lat,
    lon,
    altitudeFt,
    groundSpeedKt: num(ac.gs),
    trackDeg: num(ac.track),
    verticalRateFpm,
    distanceKm: round(haversineKm(centerLat, centerLon, lat, lon), 3),
    bearingDeg: round(bearingDeg(centerLat, centerLon, lat, lon), 2),
  };
}
