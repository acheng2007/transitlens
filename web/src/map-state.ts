import type { Bus } from './buses';
import type { Position } from './buses';
import { normalizeDeg } from './geo';

export const KM_PER_MILE = 1.609344;
export type MapState = { mode: 'compact' | 'expanded'; center: Position | null; responseCenter: Position | null; extentKm: number; headingDeg: number | null };
export type MapAction = { type: 'set_map_mode'; mode: MapState['mode'] } | { type: 'set_map_extent'; extentKm: number };
export function boundedExtent(km: number): number { return Math.max(0.1, Math.min(400, km)); }
export function createMapState(radiusKm: number): MapState {
  return { mode: 'compact', center: null, responseCenter: null, extentKm: boundedExtent(radiusKm), headingDeg: null };
}
/** Runtime validation also applies to future assistant actions. */
export function applyMapAction(state: MapState, action: MapAction): MapState {
  if (action.type === 'set_map_mode' && ['compact', 'expanded'].includes(action.mode)) return { ...state, mode: action.mode };
  if (action.type === 'set_map_extent' && Number.isFinite(action.extentKm) && action.extentKm > 0) return { ...state, extentKm: boundedExtent(action.extentKm) };
  return state;
}
export function compassLimitKm(miles: number | null): number | null {
  return miles === null ? null : (Number.isFinite(miles) && miles > 0 ? miles : 1) * KM_PER_MILE;
}
export function compassBuses(buses: Bus[], limitKm: number | null): Bus[] {
  return limitKm === null ? buses : buses.filter(b => b.distanceKm <= limitKm);
}
// Web Mercator, matching the street renderer. Extent is center-to-edge distance.
export function mercatorPoint(p: Position): [number, number] {
  const lat = Math.max(-85.051129, Math.min(85.051129, p.lat)) * Math.PI / 180;
  return [(p.lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2];
}
export function mapZoom(state: MapState, size: number): number {
  return Math.log2(size * 40075.016686 * Math.cos((state.center?.lat ?? 0) * Math.PI / 180) / (1024 * state.extentKm));
}
export function mapPoint(p: Position, state: MapState, size: number): [number, number] {
  if (!state.center) return [size / 2, size / 2];
  const a = mercatorPoint(p), c = mercatorPoint(state.center);
  const scale = 512 * 2 ** mapZoom(state, size);
  const dx = (((a[0] - c[0] + 0.5) % 1 + 1) % 1 - 0.5) * scale;
  const dy = (a[1] - c[1]) * scale;
  const angle = normalizeDeg(state.headingDeg ?? 0) * Math.PI / 180;
  return [size / 2 + dx * Math.cos(angle) + dy * Math.sin(angle), size / 2 - dx * Math.sin(angle) + dy * Math.cos(angle)];
}
