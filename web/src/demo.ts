import fixture from '../../shared/fixtures/gainesville-network.json';
import type { RouteOverlay } from '../../shared/journey';
import type { TransitPattern } from '../../shared/transit';
import type { Bus, BusFeed } from './buses';
import { REITZ_CENTER, relativeBuses } from './buses';
import { bearingDeg, haversineKm } from './geo';

export const DEMO_PATTERNS = fixture.patterns as RouteOverlay[];
/** Focused-route overlays in showcase mode use the fixture without live requests. */
export function demoPattern(id: string): TransitPattern | null {
  const route = DEMO_PATTERNS.find(p => p.patternId === id);
  if (!route) return null;
  return {
    id, routeId: route.routeId, routeDisplay: route.routeId, routeName: route.name,
    routeColor: route.color, direction: route.direction, lengthKm: null, detour: false,
    points: route.shape.map(p => [p.lat, p.lon]),
    stops: route.stops.map((s, sequence) => ({ ...s, sequence, distanceKm: null })),
  };
}
/** Explicit synthetic feed, with movement along captured real route geometry. */
export function startDemoFeed(): BusFeed {
  const started = performance.now();
  const paths = DEMO_PATTERNS.map(p => {
    const cumulative = [0];
    for (let i = 1; i < p.shape.length; i++) cumulative.push(cumulative[i - 1] + haversineKm(p.shape[i-1].lat, p.shape[i-1].lon, p.shape[i].lat, p.shape[i].lon));
    return { p, cumulative, length: cumulative.at(-1)! };
  });
  return {
    get() {
      const elapsed = (performance.now() - started) / 1000;
      const buses: Bus[] = Array.from({ length: 10 }, (_, i) => {
        const { p, cumulative, length } = paths[i % paths.length];
        const distance = ((i * 0.29) + elapsed * 0.00536) % length;
        let segment = cumulative.findIndex(x => x > distance);
        if (segment < 1) segment = 1;
        const a = p.shape[segment - 1], b = p.shape[segment];
        const t = (distance - cumulative[segment - 1]) / (cumulative[segment] - cumulative[segment - 1] || 1);
        return { id: `demo-${i+1}`, route: p.routeId, patternId: p.patternId,
          destination: i === 7 ? null : p.stops.at(-1)!.name,
          lat: a.lat + (b.lat-a.lat)*t, lon: a.lon+(b.lon-a.lon)*t,
          headingDeg: bearingDeg(a.lat,a.lon,b.lat,b.lon), speedMph: i % 3 ? 12 : null,
          delayed: i === 3 ? true : i === 7 ? null : false,
          passengerLoad: i === 2 ? 'FULL' : i % 2 ? 'HALF_EMPTY' : 'EMPTY', distanceKm: 0, bearingDeg: 0 };
      });
      return { buses: relativeBuses(buses, REITZ_CENTER), status: 'DEMO · synthetic buses on captured RTS routes', declinationDeg: null, position: REITZ_CENTER, responseCenter: REITZ_CENTER };
    },
    stop() {},
  };
}
