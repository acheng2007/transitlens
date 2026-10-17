/** Public transit contract. All bearings are clockwise from true north. */
export type Bus = {
  id: string;
  route: string;
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
  /** RTS pattern the vehicle is executing; null when the upstream omits it. */
  patternId?: string | null;
};

export type BusesResponse = {
  center: { lat: number; lon: number };
  demo: false;
  magneticDeclinationDeg: number | null;
  fetchedAt: string | null;
  status: 'available' | 'stale' | 'unavailable';
  buses: Bus[];
};

/**
 * Route, pattern, and stop data from bus-service `/api/transit/*`.
 * IDs are RTS identifiers kept as strings; stop IDs can have leading zeros.
 * Distances are kilometers converted from upstream feet.
 */
export type TransitStatus = 'available' | 'stale' | 'unavailable';

export type TransitEnvelope = {
  status: TransitStatus;
  /** Last successful catalog retrieval; null before any success. */
  fetchedAt: string | null;
};

export type TransitRoute = {
  id: string;
  /** Rider-facing route number. */
  display: string;
  name: string | null;
  /** `#rrggbb`, or null when RTS gives no valid color. */
  color: string | null;
  directions: string[];
};

export type PatternStop = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Zero-based order among this pattern's stops. */
  sequence: number;
  /** Distance along the pattern from its start, when RTS reports it. */
  distanceKm: number | null;
};

export type TransitPattern = {
  id: string;
  routeId: string;
  routeDisplay: string;
  routeName: string | null;
  routeColor: string | null;
  direction: string | null;
  lengthKm: number | null;
  /** True for patterns RTS created for a detour. */
  detour: boolean;
  /** Ordered [lat, lon] geometry, including stops and waypoints. */
  points: [number, number][];
  stops: PatternStop[];
};

export type StopService = {
  routeId: string;
  routeDisplay: string;
  direction: string | null;
  patternId: string;
};

export type TransitStop = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  routes: StopService[];
};

export type NearbyStop = TransitStop & { distanceKm: number; bearingDeg: number };

export type StopRef = { id: string; name: string; lat: number; lon: number };

/** Straight-line cue. It is never a walkable path. */
export type ApproximateLeg = {
  distanceKm: number;
  bearingDeg: number;
  note: 'approximate direction, not a walking route';
};

export type DirectServiceOption = {
  routeId: string;
  routeDisplay: string;
  routeName: string | null;
  routeColor: string | null;
  direction: string | null;
  patternId: string;
  detour: boolean;
  boardStop: StopRef;
  alightStop: StopRef;
  stopsBetween: number;
  rideKm: number | null;
  /** Live vehicles currently reporting this route and direction, not an arrival prediction. */
  activeVehicleCount: number;
  /** Present when the origin was given as coordinates. */
  approachToBoarding: ApproximateLeg | null;
  /** Present when the destination was given as coordinates. */
  alightingToDestination: ApproximateLeg | null;
};

export type DirectServiceEndpoint = {
  stopId: string | null;
  name: string | null;
  lat: number;
  lon: number;
};

export type TransitRoutesResponse = TransitEnvelope & { routes: TransitRoute[] };
export type TransitRouteResponse = TransitEnvelope & { route: TransitRoute & { patterns: TransitPattern[] } };
export type TransitPatternResponse = TransitEnvelope & { pattern: TransitPattern };
export type NearbyStopsResponse = TransitEnvelope & { center: { lat: number; lon: number }; stops: NearbyStop[] };
export type StopSearchResponse = TransitEnvelope & { query: string; stops: TransitStop[] };
export type DirectServiceResponse = TransitEnvelope & {
  coverage: 'direct-service';
  limitations: string[];
  searchRadiusKm: number;
  origin: DirectServiceEndpoint;
  destination: DirectServiceEndpoint;
  options: DirectServiceOption[];
};
