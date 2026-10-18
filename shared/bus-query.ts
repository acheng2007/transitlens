import type { Arrival, GeoPoint, RouteOverlay, TransitStop } from './journey';

export type BusObservation = GeoPoint & {
  busId: string; routeId: string; patternId: string | null; destination: string | null;
  distanceKm: number; alongRouteKm: number | null;
  progress: 'approaching' | 'passed' | 'not_served' | 'unknown'; prediction: Arrival | null;
};
export type BusStopResult = {
  query: string; routeId: string | null; busId: string | null; demo: boolean;
  networkStatus: 'available' | 'partial' | 'stale' | 'unavailable'; fetchedAt: string | null;
  vehicleStatus: 'available' | 'stale' | 'unavailable'; vehicleFetchedAt: string | null;
  status: 'available' | 'not_found' | 'ambiguous' | 'unavailable';
  stops: TransitStop[]; stop: TransitStop | null; vehicles: BusObservation[]; routes: RouteOverlay[];
};
export type BusChoice = GeoPoint & { id: string; routeId: string; patternId: string | null; destination: string | null };
