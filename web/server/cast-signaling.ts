// Vite dev-server plugin: tiny WebRTC signaling relay for casting the headset view to a laptop.
//
// Only the SDP offer/answer goes through here (and through ngrok for the phone); the video itself
// flows peer-to-peer. ICE is non-trickle: each side waits for candidate gathering to finish and
// sends one complete SDP, so a single offer + answer is all that's exchanged.
//
//   viewer (laptop, /cast.html)          phone (headset)
//   POST /api/cast/offer {sdp} ──►  store  ◄── GET /api/cast/offer?after=<id>  (polls)
//   GET  /api/cast/answer?id=  ──►  store  ◄── POST /api/cast/answer {id, sdp}
//
// Only the most recent offer is kept: a viewer reload simply replaces it and the phone picks it up.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

type Session = { id: number; offer: string; answer: string | null };

let latest: Session | null = null;
let nextId = 1;

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  if (body === undefined) return res.end();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function castSignaling(): Plugin {
  return {
    name: 'cast-signaling',
    configureServer(server) {
      // Mounted at /api/cast; connect strips the prefix, so req.url is e.g. "/offer?after=3".
      server.middlewares.use('/api/cast', async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local');
        try {
          if (url.pathname === '/offer' && req.method === 'POST') {
            const { sdp } = await readJson(req);
            if (typeof sdp !== 'string') return send(res, 400, { error: 'sdp required' });
            latest = { id: nextId++, offer: sdp, answer: null };
            return send(res, 200, { id: latest.id });
          }
          if (url.pathname === '/offer' && req.method === 'GET') {
            const after = Number(url.searchParams.get('after') ?? 0);
            if (latest && latest.id > after) return send(res, 200, { id: latest.id, sdp: latest.offer });
            return send(res, 204);
          }
          if (url.pathname === '/answer' && req.method === 'POST') {
            const { id, sdp } = await readJson(req);
            if (!latest || latest.id !== id) return send(res, 409, { error: 'offer is no longer current' });
            latest.answer = sdp;
            return send(res, 200, { ok: true });
          }
          if (url.pathname === '/answer' && req.method === 'GET') {
            const id = Number(url.searchParams.get('id'));
            if (latest && latest.id === id && latest.answer) return send(res, 200, { sdp: latest.answer });
            return send(res, 204);
          }
        } catch (e) {
          return send(res, 400, { error: String(e) });
        }
        next();
      });
    },
  };
}
