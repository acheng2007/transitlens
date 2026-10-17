export type TransitContext = {
  focusedBusId: string | null;
  previousBusId?: string | null;
  position: { lat: number; lon: number } | null;
  radiusKm: number;
  map: { mode: 'compact' | 'expanded'; extentKm: number };
};
export type TransitAction =
  | { type: 'set_map_mode'; mode: 'compact' | 'expanded' }
  | { type: 'set_map_extent'; extentKm: number };
export type TransitReply = {
  requestId: string;
  answer: string;
  actions: TransitAction[];
  source: 'gemini' | 'local';
  focusedBusId: string | null;
};
