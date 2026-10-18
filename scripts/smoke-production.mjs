// Run against the fixture-only Compose override, never an instance containing private cast sessions.
import assert from 'node:assert/strict';
const origin = process.argv[2] ?? 'http://127.0.0.1:8088';
async function get(path, options) {
  return fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(10000) });
}
async function post(path, body) {
  return get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
assert.equal((await get('/healthz')).status, 200);
const html = await (await get('/')).text();
assert.match(html, /TransitLens/);
assert.equal((await get('/cast.html')).status, 200);
assert.equal((await get('/manifest.webmanifest')).status, 200);
const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/);
assert.ok(asset, 'Built JavaScript entry exists');
assert.equal((await get(asset[1])).status, 200);
for (const endpoint of ['/api/buses/health', '/api/voice/health']) {
  const health = await (await get(endpoint)).json();
  assert.equal(health.ok, true);
  assert.equal(health.hasKey, false, 'Smoke stack must have no provider keys');
}
const buses = await (await get('/api/buses/nearby?lat=29.6465&lon=-82.3478&radiusKm=5&demo=true')).json();
assert.equal(buses.demo, true);
assert.ok(buses.buses.length >= 8);
const reply = await (await post('/api/voice/ask', { requestId: `smoke-${Date.now()}`, question: 'full size the map', context: { dataMode: 'demo' } })).json();
assert.deepEqual(reply.actions, [{ type: 'set_map_mode', mode: 'expanded' }]);
assert.equal(reply.source, 'local');
const offer = await (await post('/api/cast/offer', { sdp: 'production-smoke-offer' })).json();
assert.equal((await post('/api/cast/answer', { id: offer.id, sdp: 'production-smoke-answer' })).status, 200);
assert.deepEqual(await (await get(`/api/cast/answer?id=${offer.id}`)).json(), { sdp: 'production-smoke-answer' });
assert.equal((await get('/.env')).status, 404);
console.log('Production smoke passed: built UI, assets, both services, demo buses, voice actions and cast signaling.');
