import { createServer, request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCastHandler } from './cast-signaling.ts';

type Options = { dist?: string; busUrl?: string; voiceUrl?: string; publicUrl?: string };
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/** Built assets and same-origin APIs, without Vite or runtime npm dependencies. */
export function createProductionServer(options: Options = {}) {
  const root = resolve(options.dist ?? fileURLToPath(new URL('../dist/', import.meta.url)));
  const bus = new URL(options.busUrl ?? process.env.BUS_SERVICE_URL ?? 'http://127.0.0.1:8003');
  const voice = new URL(options.voiceUrl ?? process.env.VOICE_SERVICE_URL ?? 'http://127.0.0.1:8002');
  for (const upstream of [bus, voice]) {
    if (upstream.protocol !== 'http:' || upstream.username || upstream.password || upstream.pathname !== '/') throw new Error('Internal service URLs must be HTTP origins');
  }
  const cast = createCastHandler();
  const server = createServer(async (req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (!['GET', 'HEAD', 'POST'].includes(req.method ?? '')) return json(405, { error: 'Method not allowed' });
      if (url.pathname === '/healthz' && req.method === 'GET') {
        await stat(resolve(root, 'index.html'));
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/phone-url') return json(200, { url: options.publicUrl ?? process.env.PUBLIC_URL ?? null });
      if (url.pathname.startsWith('/api/cast/')) {
        req.url = req.url!.slice('/api/cast'.length);
        return await cast(req, res, () => json(404, { error: 'Not found' }));
      }
      const upstream = /^\/api\/(buses|transit)(\/|$)/.test(url.pathname) ? bus : /^\/api\/voice(\/|$)/.test(url.pathname) ? voice : null;
      if (upstream) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size <= 512 * 1024) chunks.push(Buffer.from(chunk));
        }
        if (size > 512 * 1024) return json(413, { error: 'Request too large' });
        const body = Buffer.concat(chunks);
        const proxy = httpRequest(new URL(url.pathname + url.search, upstream), {
          method: req.method,
          headers: { ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}), 'content-length': body.length },
        }, response => {
          res.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store' });
          response.on('error', () => res.destroy());
          response.pipe(res);
        });
        proxy.setTimeout(40000, () => proxy.destroy());
        proxy.on('error', () => {
          if (res.headersSent) res.destroy();
          else if (!res.destroyed) json(502, { error: 'Service temporarily unavailable' });
        });
        res.on('close', () => { if (!res.writableEnded) proxy.destroy(); });
        proxy.end(body);
        return;
      }
      if (url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' });
      if (req.method === 'POST') return json(405, { error: 'Method not allowed' });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) return json(404, { error: 'Not found' });
      const file = await realpath(resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`));
      if (!file.startsWith(await realpath(root) + sep)) return json(404, { error: 'Not found' });
      const info = await stat(file);
      if (!info.isFile()) return json(404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': info.size,
        'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const code = (error as NodeJS.ErrnoException).code;
      json(code === 'ENOENT' || code === 'ENOTDIR' || error instanceof URIError ? 404 : 503, { error: 'Resource unavailable' });
    }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const server = createProductionServer();
  server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.info(`TransitLens production gateway listening on ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
