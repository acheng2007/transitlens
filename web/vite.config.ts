import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { castSignaling } from './server/cast-signaling';

const SHARED_DIR = fileURLToPath(new URL('../shared', import.meta.url));

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
      '/api/transit': 'http://127.0.0.1:8003',
      '/api/voice': 'http://127.0.0.1:8002',
    },
  },
});
