import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../../shared/fixtures/gainesville-network.json';
import type { BusChoice, BusStopResult } from '../../shared/bus-query.ts';
import type { RouteOverlay } from '../../shared/journey.ts';
import { createJourneyState, reduceJourney } from '../src/journey-state.ts';
import { parseTransitReply } from '../src/voice/transit.ts';
import { startBusStopRefresh } from '../src/bus-stop-refresh.ts';

const route = fixture.patterns[0] as RouteOverlay;
const stop = route.stops[1];
function result(): BusStopResult {
  return { query: stop.id, routeId: route.routeId, busId: 'v1', demo: true,
    networkStatus: 'available', fetchedAt: new Date().toISOString(), vehicleStatus: 'available', vehicleFetchedAt: new Date().toISOString(),
    status: 'available', stops: [stop], stop, routes: [route], vehicles: [{ busId: 'v1', routeId: route.routeId,
      patternId: route.patternId, destination: 'Destination', lat: stop.lat, lon: stop.lon, distanceKm: 0.2,
      alongRouteKm: 0.3, progress: 'approaching', prediction: null }] };
}
const envelope = (r: BusStopResult) => ({ requestId: 'query', answer: 'Stop lookup.', source: 'gemini', focusedBusId: null,
  actions: [{ type: 'show_bus_stop', result: r }] });

test('bus-stop actions reject corrupt positions, wrong buses, and invalid progress atomically', () => {
  assert.equal(parseTransitReply(envelope(result()), 'query').actions.length, 1);
  const original = result();
  for (const corrupt of [
    { ...original, stop: { ...stop, id: 'invented' } },
    { ...original, vehicles: [{ ...original.vehicles[0], lat: 91 }] },
    { ...original, vehicles: [{ ...original.vehicles[0], busId: 'different' }] },
    { ...original, vehicles: [{ ...original.vehicles[0], progress: 'passed' }] },
    { ...original, status: 'ambiguous' },
  ]) assert.throws(() => parseTransitReply({ ...envelope(corrupt as BusStopResult),
    actions: [{ type: 'set_map_mode', mode: 'expanded' }, ...envelope(corrupt as BusStopResult).actions] }, 'query'));
});

test('bus/stop selection and explicit boarding share state without gaze implying boarding', () => {
  const bus: BusChoice = { id: 'v1', routeId: route.routeId, patternId: route.patternId, destination: 'Destination', lat: stop.lat, lon: stop.lon };
  let state = reduceJourney(createJourneyState(), { type: 'show_bus_stop', result: result() });
  assert.equal(state.busStop?.stop?.id, stop.id);
  assert.equal(state.onboardBus, null);
  state = reduceJourney(state, { type: 'set_onboard_bus', bus });
  assert.equal(state.busStop, null);
  assert.equal(state.onboardBus?.id, 'v1');
  state = reduceJourney(state, { type: 'clear_guidance' });
  assert.equal(state.onboardBus?.id, 'v1');
  state = reduceJourney(state, { type: 'set_onboard_bus', bus: null });
  assert.deepEqual(state, createJourneyState());
});

test('declaring an onboard vehicle preserves the destination for the next travel question', () => {
  const bus: BusChoice = { id: 'v1', routeId: route.routeId, patternId: route.patternId, destination: 'Destination', lat: stop.lat, lon: stop.lon };
  const state = reduceJourney({ ...createJourneyState(), destinationQuery: 'Reitz Union' }, { type: 'set_onboard_bus', bus });
  assert.equal(state.destinationQuery, 'Reitz Union');
  assert.equal(state.plan, null);
  assert.equal(state.onboardBus?.id, 'v1');
});

test('stop refresh never overwrites a newer selection and marks retained data stale on failure', async () => {
  const previousFetch = globalThis.fetch;
  let selected: BusStopResult | null = result();
  let resolve!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise<Response>(r => { resolve = r; }); };
  const refresher = startBusStopRefresh(() => selected, r => { selected = r; });
  try {
    const old = selected;
    const request = refresher.refresh();
    await refresher.refresh();
    assert.equal(calls, 1);
    selected = { ...result(), query: 'new selection' };
    resolve(new Response(JSON.stringify(old)));
    await request;
    assert.equal(selected.query, 'new selection');
    globalThis.fetch = async () => { throw new Error('Network unavailable'); };
    await refresher.refresh();
    assert.equal(selected.vehicleStatus, 'stale');
    assert.equal(selected.stop?.id, stop.id);
  } finally { refresher.stop(); globalThis.fetch = previousFetch; }
});
