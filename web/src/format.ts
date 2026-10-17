// Transit display formatting.

import type { Bus } from './buses';

export function statusTag(p: Bus): string | null {
  return p.delayed === true ? 'DELAYED' : p.delayed === false ? 'NO DELAY REPORTED' : null;
}

export function cardLines(p: Bus): string[] {
    return [
      `ROUTE ${p.route}`,
      p.destination ?? 'Destination unavailable',
      [`${(p.distanceKm / 1.609344).toFixed(2)} mi away`, p.speedMph == null ? null : `${Math.round(p.speedMph)} mph`].filter(Boolean).join(' · '),
      ...(p.passengerLoad ? [p.passengerLoad.replaceAll('_', ' ')] : []),
    ];
}
