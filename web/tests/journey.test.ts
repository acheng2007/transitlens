import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../../shared/fixtures/gainesville-network.json';
import type { Journey, RouteOverlay } from '../../shared/journey.ts';
import { arrivalLabel, createJourneyState, reduceJourney, validJourney } from '../src/journey-state.ts';
import { parseTransitReply } from '../src/voice/transit.ts';
import { startDemoFeed } from '../src/demo.ts';
const overlay = fixture.patterns.find(p => p.routeId === '38') as RouteOverlay;
const journey: Journey = { id:'route-option',routeId:'38',routeName:overlay.name,color:overlay.color,patternId:overlay.patternId,direction:overlay.direction,
  boardingStop:overlay.stops[0],alightingStop:overlay.stops.find(s=>s.name.includes('Shands'))!,walkKm:0.17,rideStops:3,overlay,activeVehicles:1,prediction:null };
test('validate grounded routes; reject corrupt geometry and reversed or unknown stops atomically',()=>{
  assert.ok(validJourney(journey));
  const reply={requestId:'r',answer:'Trip found',source:'gemini',focusedBusId:null,actions:[{type:'start_guidance',journey}]};
  assert.equal(parseTransitReply(reply,'r').actions.length,1);
  for(const corrupt of [
    {...journey,boardingStop:journey.alightingStop,alightingStop:journey.boardingStop},
    {...journey,boardingStop:{...journey.boardingStop,id:'model-invented'}},
    {...journey,overlay:{...overlay,shape:[{lat:181,lon:0},...overlay.shape]}},
    {...journey,walkKm:100},
  ]) assert.throws(()=>parseTransitReply({...reply,actions:[{type:'set_map_mode',mode:'expanded'},{type:'start_guidance',journey:corrupt}]},'r'));
});
test('guidance targets a stationary stop and cancellation clears the trip',()=>{
  const state=reduceJourney(createJourneyState(),{type:'start_guidance',journey});
  assert.equal(state.guidance?.boardingStop.id,journey.boardingStop.id);
  assert.equal(state.routes[0].patternId,overlay.patternId);
  assert.deepEqual(reduceJourney(state,{type:'clear_guidance'}),createJourneyState());
});
test('arrival labels distinguish verified predictions, expired data, missing data and synthetic demo',()=>{
  const now=Date.parse('2026-10-16T23:00:00Z');
  const prediction={status:'available' as const,minutes:5,fetchedAt:new Date(now-60000).toISOString(),label:'RTS prediction'};
  assert.equal(arrivalLabel({...journey,prediction},now),'RTS predicts 4 min');
  assert.equal(arrivalLabel({...journey,prediction:{...prediction,fetchedAt:new Date(now-100000).toISOString()}},now),'Arrival needs refresh');
  assert.equal(arrivalLabel({...journey,prediction:{...prediction,status:'demo'}},now),'DEMO · 5 min (scripted)');
  assert.equal(arrivalLabel(journey,now),'Arrival not available');
});
test('showcase has ten synthetic vehicles on captured routes and a fixed public location',()=>{
  const feed=startDemoFeed();const data=feed.get();
  assert.equal(data.buses.length,10);
  assert.equal(new Set(data.buses.map(b=>b.id)).size,10);
  assert.ok(data.status.includes('synthetic'));
  assert.ok(data.buses.every(b=>b.id.startsWith('demo-') && Number.isFinite(b.bearingDeg) && b.distanceKm>=0));
  assert.equal(data.position?.lat,29.6465);
  assert.ok(data.buses.some(b=>b.destination===null));
  feed.stop();
});
