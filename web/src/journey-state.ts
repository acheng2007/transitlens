import type { TransitAction } from '../../shared/assistant';
import type { GeoPoint, Journey, JourneyPlan, RouteOverlay, TransitStop } from '../../shared/journey';
import type { BusChoice, BusObservation, BusStopResult } from '../../shared/bus-query';

export type JourneyState = { plan: JourneyPlan | null; routes: RouteOverlay[]; guidance: Journey | null; selectedJourneyId: string | null;
  busStop: BusStopResult | null; busChoices: BusChoice[]; onboardBus: BusChoice | null; destinationQuery: string | null };
export const createJourneyState = (): JourneyState => ({ plan: null, routes: [], guidance: null, selectedJourneyId: null, busStop: null, busChoices: [], onboardBus: null, destinationQuery: null });
const str = (x: unknown, n = 300): x is string => typeof x === 'string' && x.length > 0 && x.length <= n;
const finite = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const point = (p: GeoPoint): boolean => !!p && finite(p.lat, -90, 90) && finite(p.lon, -180, 180);
const stop = (s: TransitStop): boolean => point(s) && str(s.id, 120) && str(s.name, 200) && Number.isInteger(s.sequence) && s.sequence >= 0;
const nullableText = (v: unknown, max = 300) => v === null || str(v, max);
const arrival = (p: Journey['prediction']) => p === null || !!p && ['available','unavailable','demo'].includes(p.status) &&
  (p.minutes === null || finite(p.minutes,0,1440)) && typeof p.label === 'string' && nullableText(p.fetchedAt);
export function validBusChoice(b: BusChoice): boolean {
  return !!b && point(b) && str(b.id,100) && str(b.routeId,30) && nullableText(b.patternId,100) && nullableText(b.destination);
}
export function validObservation(b: BusObservation): boolean {
  return !!b && point(b) && str(b.busId,100) && str(b.routeId,30) && nullableText(b.patternId,100) && nullableText(b.destination) &&
    finite(b.distanceKm,0,500) && (b.alongRouteKm === null || finite(b.alongRouteKm,0,500)) &&
    ['approaching','passed','not_served','unknown'].includes(b.progress) && arrival(b.prediction) &&
    (b.alongRouteKm === null || b.progress === 'approaching');
}
export function validBusStopResult(r: BusStopResult): boolean {
  return !!r && str(r.query,120) && nullableText(r.routeId,30) && nullableText(r.busId,100) && typeof r.demo === 'boolean' &&
    ['available','partial','stale','unavailable'].includes(r.networkStatus) && nullableText(r.fetchedAt) &&
    ['available','stale','unavailable'].includes(r.vehicleStatus) && nullableText(r.vehicleFetchedAt) &&
    ['available','not_found','ambiguous','unavailable'].includes(r.status) &&
    Array.isArray(r.stops) && r.stops.length <= 8 && r.stops.every(stop) &&
    (r.stop === null || stop(r.stop) && r.stops.some(s=>s.id===r.stop!.id)) &&
    Array.isArray(r.vehicles) && r.vehicles.length <= 6 && r.vehicles.every(b=>validObservation(b) && (!r.routeId || r.routeId===b.routeId) && (!r.busId || r.busId===b.busId)) &&
    Array.isArray(r.routes) && r.routes.length <= 6 && r.routes.every(validOverlay) &&
    (r.status === 'available' || r.vehicles.length === 0 && r.stop === null);
}
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
    (j.onboard === undefined || typeof j.onboard === 'boolean') &&
    (j.vehicles === undefined || Array.isArray(j.vehicles) && j.vehicles.length <= 6 && j.vehicles.every(v=>validObservation(v) && v.routeId===j.routeId && v.patternId===j.patternId)) &&
    (j.vehicleStatus === undefined || ['available','stale','unavailable'].includes(j.vehicleStatus)) &&
    (j.vehicleFetchedAt === undefined || nullableText(j.vehicleFetchedAt)) &&
    (j.prediction === null || (!!j.prediction && ['available', 'unavailable', 'demo'].includes(j.prediction.status) &&
      (j.prediction.minutes === null || finite(j.prediction.minutes, 0, 1440)) && typeof j.prediction.label === 'string' &&
      (j.prediction.fetchedAt === null || typeof j.prediction.fetchedAt === 'string')));
}
export function validPlan(p: JourneyPlan): boolean {
  return !!p && str(p.query, 120) && typeof p.demo === 'boolean' && ['available','partial','stale','unavailable'].includes(p.networkStatus) &&
    ['available','not_found','unavailable','ambiguous','no_direct_routes'].includes(p.status) &&
    (p.fetchedAt === null || typeof p.fetchedAt === 'string') && typeof p.scope === 'string' &&
    Array.isArray(p.options) && p.options.length <= 6 && p.options.every(validJourney) && Array.isArray(p.destinations) && p.destinations.length <= 8 && p.destinations.every(stop) &&
    (p.recommendedJourneyId == null || p.options.some(o=>o.id===p.recommendedJourneyId));
}
export function reduceJourney(state: JourneyState, action: TransitAction): JourneyState {
  if (action.type === 'show_journeys') return { ...state, plan: action.plan, destinationQuery: action.plan.query, routes: action.plan.options.slice(0, 3).map(o => o.overlay), guidance: null, selectedJourneyId: null, busStop: null, busChoices: [] };
  if (action.type === 'show_routes') return { ...state, plan: null, destinationQuery: null, routes: action.routes, guidance: null, selectedJourneyId: null, busStop: null, busChoices: [] };
  if (action.type === 'show_bus_stop') return { ...state, plan: null, destinationQuery: null, guidance: null, selectedJourneyId: null, busStop: action.result, routes: action.result.routes, busChoices: [] };
  if (action.type === 'show_bus_choices') return { ...state, busChoices: action.buses };
  if (action.type === 'set_onboard_bus') return { ...createJourneyState(), onboardBus: action.bus, destinationQuery: state.destinationQuery };
  if (action.type === 'start_guidance') {
    const j = action.journey, start = j.boardingStop.sequence, end = j.alightingStop.sequence;
    const segment = { ...j.overlay, shape: j.overlay.shape.slice(start, end+1), stops: j.overlay.stops.filter(s=>s.sequence>=start && s.sequence<=end).map(s=>({...s,sequence:s.sequence-start})) };
    return { ...state, routes: [segment], guidance: j, selectedJourneyId: j.id };
  }
  if (action.type === 'clear_guidance') return { ...createJourneyState(), onboardBus: state.onboardBus };
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
