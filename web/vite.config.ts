import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { castSignaling } from './server/cast-signaling';

const SHARED_DIR = fileURLToPath(new URL('../shared', import.meta.url));
/** Written by `npm run phone` while its HTTPS tunnel is up. */
const PHONE_URL_FILE = fileURLToPath(new URL('./.phone-url', import.meta.url));

export default defineConfig({
  plugins: [
    // WebRTC signaling for casting the headset view to /cast.html on a laptop.
    castSignaling(),
    {
      // ../shared is outside the web root, so Vite doesn't watch it by default and keeps serving
      // a stale copy of the fixture after it's regenerated. Watch it explicitly.
      name: 'watch-shared',
      configureServer(server) {
        server.watcher.add(SHARED_DIR);
      },
    },
    {
      // Lets the laptop's start screen show the phone tunnel's QR code.
      name: 'phone-url',
      configureServer(server) {
        server.middlewares.use('/api/phone-url', (_req, res) => {
          let url = '';
          try {
            url = readFileSync(PHONE_URL_FILE, 'utf8').trim();
          } catch {}
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ url: url || null }));
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        cast: fileURLToPath(new URL('./cast.html', import.meta.url)),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    // Allow temporary HTTPS phone-test tunnels to reach the dev server.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'],
    // Allow importing ../shared/fixtures.
    fs: { allow: ['..'] },
    // One tunnel for everything: the phone only ever talks to this server.
    proxy: {
      '/api/buses': 'http://127.0.0.1:8003',
      '/api/voice': 'http://127.0.0.1:8002',
    },
  },
});
