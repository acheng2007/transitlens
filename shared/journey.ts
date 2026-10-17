export type GeoPoint = { lat: number; lon: number };
export type TransitStop = GeoPoint & { id: string; name: string; sequence: number };
export type RouteOverlay = {
  id: string; patternId: string; routeId: string; name: string; color: string; direction: string;
  shape: GeoPoint[]; stops: TransitStop[];
};
export type Arrival = { status: 'available' | 'unavailable' | 'demo'; minutes: number | null; vehicleId?: string | null; fetchedAt: string | null; label: string };
export type Journey = {
  id: string; routeId: string; routeName: string; color: string; patternId: string; direction: string;
  boardingStop: TransitStop; alightingStop: TransitStop; walkKm: number; rideStops: number;
  overlay: RouteOverlay; activeVehicles: number; prediction: Arrival | null;
};
export type JourneyPlan = {
  query: string; demo: boolean; networkStatus: string; fetchedAt: string | null;
  status: 'available' | 'not_found' | 'unavailable' | 'ambiguous' | 'no_direct_routes';
  scope: string; options: Journey[]; destinations: TransitStop[];
};
