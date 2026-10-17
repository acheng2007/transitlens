/** Public transit contract. All bearings are clockwise from true north. */
export type Bus = {
  id: string;
  route: string;
  patternId?: string | null;
  destination: string | null;
  lat: number;
  lon: number;
  headingDeg: number | null;
  speedMph: number | null;
  delayed: boolean | null;
  passengerLoad: string | null;
  distanceKm: number;
  bearingDeg: number;
  offsetDeg?: number;
};

export type BusesResponse = {
  center: { lat: number; lon: number };
  demo: false;
  magneticDeclinationDeg: number | null;
  fetchedAt: string | null;
  status: 'available' | 'stale' | 'unavailable';
  buses: Bus[];
};
