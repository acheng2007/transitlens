import type { Journey, JourneyPlan, RouteOverlay } from './journey';
export type TransitContext = {
  dataMode?: 'live' | 'demo';
  destinationQuery?: string | null;
  selectedJourneyId?: string | null;
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
  | { type: 'clear_guidance' };
export type TransitReply = {
  requestId: string;
  answer: string;
  actions: TransitAction[];
  source: 'gemini' | 'local' | 'scripted';
  demo?: boolean;
  focusedBusId: string | null;
};
