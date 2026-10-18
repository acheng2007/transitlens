import type { Journey, JourneyPlan, RouteOverlay } from './journey';
import type { BusChoice, BusStopResult } from './bus-query';
export type Clarification = {
  id: string;
  prompt: string;
  expected: 'route' | 'stop' | 'destination' | 'vehicle' | 'choice';
  expiresAt: string;
};
export type TransitContext = {
  clarificationId?: string | null;
  dataMode?: 'live' | 'demo';
  destinationQuery?: string | null;
  selectedJourneyId?: string | null;
  sessionId?: string;
  selectedRouteId?: string | null;
  selectedBusId?: string | null;
  selectedStopId?: string | null;
  busStopQuery?: string | null;
  onboardBusId?: string | null;
  focusedBusId: string | null;
  previousBusId?: string | null;
  position: { lat: number; lon: number } | null;
  radiusKm: number;
  map: { mode: 'compact' | 'expanded'; extentKm: number };
};
export type TransitAction =
  | { type: 'set_map_mode'; mode: 'compact' | 'expanded' }
  | { type: 'set_map_extent'; extentKm: number }
  | { type: 'show_journeys'; plan: JourneyPlan }
  | { type: 'show_routes'; routes: RouteOverlay[] }
  | { type: 'start_guidance'; journey: Journey }
  | { type: 'clear_guidance' }
  | { type: 'show_bus_stop'; result: BusStopResult }
  | { type: 'show_bus_choices'; buses: BusChoice[] }
  | { type: 'set_onboard_bus'; bus: BusChoice | null };
export type TransitReply = {
  clarification?: Clarification | null;
  requestId: string;
  answer: string;
  /** Opaque, two-minute capability for approved answer speech, never arbitrary text. */
  speechId?: string | null;
  /** Approved spoken transcript, including deterministic successful-action confirmations. */
  speechText?: string | null;
  actions: TransitAction[];
  source: 'gemini' | 'local' | 'scripted';
  demo?: boolean;
  focusedBusId: string | null;
};
