// Transit display formatting.

import type { Bus } from './buses';

export function statusTag(p: Bus): string | null {
  return p.delayed === true ? 'DELAYED' : p.delayed === false ? 'NO DELAY REPORTED' : null;
}

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

export function cardLines(p: Bus): string[] {
  const c = busCard(p);
  return [`ROUTE ${c.route} · ${c.destination}`, c.stats];
}
