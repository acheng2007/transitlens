// Text shown for a plane on the HUD.

import type { Plane } from './planes';
import type { Bus } from './buses';

/** ICAO airline prefix -> IATA code, so "DAL1234" displays as "DL 1234". Common US carriers only. */
const AIRLINE_IATA: Record<string, string> = {
  DAL: 'DL',
  AAL: 'AA',
  UAL: 'UA',
  SWA: 'WN',
  JBU: 'B6',
  NKS: 'NK',
  FFT: 'F9',
  ASA: 'AS',
  AAY: 'G4',
  SKW: 'OO',
  EDV: '9E',
  ENY: 'MQ',
  RPA: 'YX',
  JIA: 'OH',
  UPS: '5X',
  FDX: 'FX',
  BAW: 'BA',
  AFR: 'AF',
  DLH: 'LH',
  KLM: 'KL',
  VIR: 'VS',
  ACA: 'AC',
};

export type AircraftStatus = 'emergency' | 'ground' | 'medical' | 'military' | 'normal';

/**
 * One status per aircraft for coloring, most important first:
 * emergency (blinking red) > on ground (grey) > medical (purple) > military (green) > normal (blue).
 */
export function aircraftStatus(p: Plane | Bus): AircraftStatus {
  if ('route' in p) return 'normal';
  if (p.emergency) return 'emergency';
  if (p.onGround) return 'ground';
  if (p.medical) return 'medical';
  if (p.military) return 'military';
  return 'normal';
}

const EMERGENCY_LABELS: Record<string, string> = {
  general: 'Emergency',
  minfuel: 'Emergency · minimum fuel',
  nordo: 'Emergency · radio failure',
  unlawful: 'Emergency · hijack',
  downed: 'Emergency · aircraft down',
};

/** Tag line shown above the card title for non-normal aircraft, e.g. "MEDICAL". */
export function statusTag(p: Plane | Bus): string | null {
  if ('route' in p) return p.delayed === true ? 'DELAYED' : p.delayed === false ? 'NO DELAY REPORTED' : null;
  switch (aircraftStatus(p)) {
    case 'emergency':
      return (EMERGENCY_LABELS[p.emergency ?? ''] ?? `Emergency · ${p.emergency}`).toUpperCase();
    case 'ground':
      return 'ON THE GROUND';
    case 'medical':
      return 'MEDICAL';
    case 'military':
      return 'MILITARY';
    case 'normal':
      return null;
  }
}

/** Short identifier: "DL 1234", else raw callsign, else registration, else hex id. */
export function flightLabel(p: Plane | Bus): string {
  if ('route' in p) return `Route ${p.route}`;
  const cs = p.callsign?.trim();
  if (!cs) return p.registration ?? p.id.toUpperCase();
  const m = /^([A-Z]{3})(\d+[A-Z]?)$/.exec(cs);
  if (m && AIRLINE_IATA[m[1]]) return `${AIRLINE_IATA[m[1]]} ${m[2]}`;
  return cs;
}

/** Rates this small are ADS-B noise around level flight (readsb reports in 64 fpm steps). */
const LEVEL_FPM = 150;

/** Climb/descent from ADS-B baro_rate: "↑ 1,200 fpm", "↓ 800 fpm", "level", or null if unknown. */
function verticalRate(p: Plane): string | null {
  const r = p.verticalRateFpm;
  if (r == null || p.onGround) return null;
  if (Math.abs(r) < LEVEL_FPM) return 'level';
  return `${r > 0 ? '↑' : '↓'} ${Math.abs(Math.round(r)).toLocaleString('en-US')} fpm`;
}

/**
 * Info card: a compact 3-line notification attached under the compass bar.
 *   DL 1234 · Delta Air Lines
 *   Airbus A321-200 · LGA → ATL
 *   4,200 ft · ↓ 800 fpm · 180 kt · 8.4 km
 * Missing fields are dropped.
 */
/** RTS BusTime passenger load (psgld) as short card text. */
const LOAD_LABELS: Record<string, string> = { EMPTY: 'Empty', HALF_EMPTY: 'Half full', FULL: 'Full' };

/** Bus card pieces: route chip, destination headline, stats line. Unknown values are omitted, never guessed. */
export function busCard(b: Bus): { route: string; destination: string; stats: string } {
  const speed = b.speedMph == null ? null : Math.round(b.speedMph) === 0 ? 'Stopped' : `${Math.round(b.speedMph)} mph`;
  const load = b.passengerLoad ? LOAD_LABELS[b.passengerLoad] ?? b.passengerLoad.replaceAll('_', ' ').toLowerCase() : null;
  return {
    route: b.route,
    destination: b.destination ?? 'Destination unknown',
    stats: [`${(b.distanceKm / 1.609344).toFixed(2)} mi`, speed, load].filter(Boolean).join(' · '),
  };
}

export function cardLines(p: Plane | Bus): string[] {
  if ('route' in p) {
    const c = busCard(p);
    return [`ROUTE ${c.route} · ${c.destination}`, c.stats];
  }
  const title = [flightLabel(p), p.airline].filter(Boolean).join(' · ');
  const route = p.origin || p.destination ? `${p.origin ?? '?'} → ${p.destination ?? '?'}` : null;
  const fallback = p.kind === 'helicopter' ? 'Helicopter' : 'Unknown aircraft';
  const type = [p.typeName ?? p.typeCode ?? fallback, route].filter(Boolean).join(' · ');
  const stats = [
    p.altitudeFt != null ? `${Math.round(p.altitudeFt).toLocaleString('en-US')} ft` : null,
    verticalRate(p),
    p.groundSpeedKt != null ? `${Math.round(p.groundSpeedKt)} kt` : null,
    `${p.distanceKm.toFixed(1)} km`,
  ]
    .filter(Boolean)
    .join(' · ');
  return [title, type, stats];
}
