import type { BusStopResult } from '../../shared/bus-query';
import { validBusStopResult } from './journey-state';

/** Refresh the selected observation without spending Gemini quota or replacing a newer choice. */
export function startBusStopRefresh(get: () => BusStopResult | null, apply: (result: BusStopResult) => void,
  intervalMs = 30000) {
  let pending: AbortController | null = null;
  let stopped = false;
  async function refresh() {
    const selection = get();
    if (stopped || pending || !selection?.stop) return;
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const params = new URLSearchParams({ stop: selection.stop.id, demo: String(selection.demo) });
      if (selection.busId) params.set('busId', selection.busId);
      if (selection.routeId) params.set('routeId', selection.routeId);
      const response = await fetch(`/api/buses/stop-distance?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error('Stop refresh unavailable');
      const result = await response.json() as BusStopResult;
      if (!validBusStopResult(result) || result.stop?.id !== selection.stop.id || result.demo !== selection.demo ||
          result.routeId !== selection.routeId || result.busId !== selection.busId) throw new Error('Invalid stop refresh');
      if (!stopped && get() === selection) apply(result);
    } catch {
      if (!stopped && get() === selection) apply({ ...selection, vehicleStatus: 'stale' });
    } finally {
      clearTimeout(timeout);
      if (pending === controller) pending = null;
    }
  }
  const timer = setInterval(() => { void refresh(); }, intervalMs);
  return { refresh, stop() { stopped = true; clearInterval(timer); pending?.abort(); pending = null; } };
}
