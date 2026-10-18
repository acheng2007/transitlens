import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionServer } from '../server/production.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('production serves built assets and APIs, preserves casting and contains failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transitlens-production-'));
  const dist = join(dir, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<h1>TransitLens</h1>');
  await writeFile(join(dist, 'cast.html'), '<h1>Cast</h1>');
  await writeFile(join(dist, 'assets/app-hash.js'), 'console.log("app")');
  await writeFile(join(dist, '.env'), 'fake private config');
  await writeFile(join(dir, 'outside.txt'), 'fake private data');
  await symlink(join(dir, 'outside.txt'), join(dist, 'escape.txt'));
  const bus = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url })); });
  const voice = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    if (req.url === '/api/voice/tts') { res.setHeader('content-type', 'audio/wav'); res.end('RIFF-test-WAVE'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url, body: text }));
  });
  let web: Server | undefined;
  try {
    const busUrl = await listen(bus), voiceUrl = await listen(voice);
    web = createProductionServer({ dist, busUrl, voiceUrl, publicUrl: 'https://transit.example.com' });
    const origin = await listen(web);
    const get = (path: string, options?: RequestInit) => fetch(origin + path, options);
    const post = (path: string, body: unknown) => get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.match(await (await get('/')).text(), /TransitLens/);
    assert.match(await (await get('/cast.html')).text(), /Cast/);
    assert.equal((await get('/assets/app-hash.js')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await get('/')).headers.get('cache-control'), 'no-cache');
    assert.equal(await (await get('/', { method: 'HEAD' })).text(), '');
    assert.deepEqual(await (await get('/healthz')).json(), { ok: true });
    for (const path of ['/.env', '/..%2foutside.txt', '/escape.txt', '/missing', '/api/unknown']) assert.equal((await get(path)).status, 404, path);
    assert.deepEqual(await (await get('/api/phone-url')).json(), { url: 'https://transit.example.com' });
    assert.equal((await (await get('/api/buses/nearby?demo=true')).json()).path, '/api/buses/nearby?demo=true');
    assert.equal((await (await get('/api/transit/routes')).json()).path, '/api/transit/routes');
    const answer = await post('/api/voice/ask', { question: 'open the map' });
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.deepEqual(JSON.parse((await answer.json()).body), { question: 'open the map' });
    const audio = await post('/api/voice/tts', { speechId: 'example' });
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    assert.equal(await audio.text(), 'RIFF-test-WAVE');
    assert.equal((await post('/api/voice/ask', { question: 'x'.repeat(524288) })).status, 413);
    const offer = await (await post('/api/cast/offer', { sdp: 'example-offer' })).json();
    assert.deepEqual(await (await get('/api/cast/offer?after=0')).json(), { id: offer.id, sdp: 'example-offer' });
    assert.equal((await post('/api/cast/answer', { id: offer.id, sdp: {} })).status, 400);
    assert.equal((await post('/api/cast/answer', { id: offer.id, sdp: 'example-answer' })).status, 200);
    assert.deepEqual(await (await get(`/api/cast/answer?id=${offer.id}`)).json(), { sdp: 'example-answer' });
    await post('/api/cast/offer', { sdp: 'new-offer' });
    assert.equal((await post('/api/cast/answer', { id: offer.id, sdp: 'old-answer' })).status, 409);
    assert.equal((await post('/api/cast/offer', { sdp: 'x'.repeat(70000) })).status, 400);
    await new Promise<void>(resolve => voice.close(() => resolve()));
    assert.equal((await get('/api/voice/health')).status, 502);
  } finally {
    for (const server of [web, bus, voice]) {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
