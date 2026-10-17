import type { TransitAction } from '../../shared/assistant';
import type { GeoPoint, Journey, JourneyPlan, RouteOverlay, TransitStop } from '../../shared/journey';

export type JourneyState = { plan: JourneyPlan | null; routes: RouteOverlay[]; guidance: Journey | null; selectedJourneyId: string | null };
export const createJourneyState = (): JourneyState => ({ plan: null, routes: [], guidance: null, selectedJourneyId: null });
const str = (x: unknown, n = 300): x is string => typeof x === 'string' && x.length > 0 && x.length <= n;
const finite = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const point = (p: GeoPoint): boolean => !!p && finite(p.lat, -90, 90) && finite(p.lon, -180, 180);
const stop = (s: TransitStop): boolean => point(s) && str(s.id, 120) && str(s.name, 200) && Number.isInteger(s.sequence) && s.sequence >= 0;
export function validOverlay(p: RouteOverlay): boolean {
  return !!p && str(p.id) && str(p.patternId) && str(p.routeId, 30) && str(p.name, 200) && str(p.direction, 100) && /^#[\da-f]{6}$/i.test(p.color) &&
    Array.isArray(p.shape) && p.shape.length >= 2 && p.shape.length <= 3000 && p.shape.every(point) &&
    Array.isArray(p.stops) && p.stops.length > 0 && p.stops.length <= 300 && p.stops.every(s => stop(s) && s.sequence < p.shape.length);
}
export function validJourney(j: Journey): boolean {
  return !!j && str(j.id) && str(j.routeId) && str(j.routeName) && str(j.direction) && validOverlay(j.overlay) && stop(j.boardingStop) && stop(j.alightingStop) &&
    j.boardingStop.sequence < j.alightingStop.sequence && j.overlay.routeId === j.routeId && j.overlay.patternId === j.patternId &&
    j.overlay.stops.some(s => s.id === j.boardingStop.id && s.sequence === j.boardingStop.sequence) &&
    j.overlay.stops.some(s => s.id === j.alightingStop.id && s.sequence === j.alightingStop.sequence) &&
    finite(j.walkKm, 0, 0.8) && Number.isInteger(j.rideStops) && j.rideStops > 0 && Number.isInteger(j.activeVehicles) && j.activeVehicles >= 0 &&
    (j.prediction === null || (!!j.prediction && ['available', 'unavailable', 'demo'].includes(j.prediction.status) &&
      (j.prediction.minutes === null || finite(j.prediction.minutes, 0, 1440)) && typeof j.prediction.label === 'string' &&
      (j.prediction.fetchedAt === null || typeof j.prediction.fetchedAt === 'string')));
}
export function validPlan(p: JourneyPlan): boolean {
  return !!p && str(p.query, 120) && typeof p.demo === 'boolean' && ['available','partial','stale','unavailable'].includes(p.networkStatus) &&
    ['available','not_found','unavailable','ambiguous','no_direct_routes'].includes(p.status) &&
    (p.fetchedAt === null || typeof p.fetchedAt === 'string') && typeof p.scope === 'string' &&
    Array.isArray(p.options) && p.options.length <= 6 && p.options.every(validJourney) && Array.isArray(p.destinations) && p.destinations.length <= 8 && p.destinations.every(stop);
}
export function reduceJourney(state: JourneyState, action: TransitAction): JourneyState {
  if (action.type === 'show_journeys') return { ...state, plan: action.plan, routes: action.plan.options.slice(0, 3).map(o => o.overlay), guidance: null, selectedJourneyId: null };
  if (action.type === 'show_routes') return { ...state, plan: null, routes: action.routes, guidance: null, selectedJourneyId: null };
  if (action.type === 'start_guidance') {
    const j = action.journey, start = j.boardingStop.sequence, end = j.alightingStop.sequence;
    const segment = { ...j.overlay, shape: j.overlay.shape.slice(start, end+1), stops: j.overlay.stops.filter(s=>s.sequence>=start && s.sequence<=end).map(s=>({...s,sequence:s.sequence-start})) };
    return { ...state, routes: [segment], guidance: j, selectedJourneyId: j.id };
  }
  if (action.type === 'clear_guidance') return createJourneyState();
  return state;
}
export function arrivalLabel(j: Journey, now = Date.now()): string {
  const p = j.prediction;
  if (!p || p.minutes === null) return 'Arrival not available';
  if (p.status === 'demo') return `DEMO · ${p.minutes} min (scripted)`;
  const age = p.fetchedAt ? (now - Date.parse(p.fetchedAt)) / 1000 : Infinity;
  if (p.status !== 'available' || !Number.isFinite(age) || age > 90 || age < -30) return 'Arrival needs refresh';
  const minutes = Math.max(0, Math.ceil(p.minutes - Math.max(0, age) / 60));
  return minutes ? `RTS predicts ${minutes} min` : 'RTS predicts due';
}
