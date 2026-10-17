import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';

// Shared modules are imported read-only from the web app (see PLAN.md, "Reuse by import").
const WEB_SRC = fileURLToPath(new URL('../../web/src', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Desktop browser only (npm run dev): api.adsb.lol has no CORS headers, so src/flights/adsb.ts
 * calls /proxy/<host>/... and this forwards it. The APK uses native HTTP instead.
 */
function apiProxy(prefix: string, target: string): Record<string, ProxyOptions> {
  return {
    [prefix]: {
      target,
      changeOrigin: true,
      rewrite: (path) => path.slice(prefix.length),
      headers: { 'User-Agent': 'SkyLens/0.1 (hackathon; dev proxy)' },
    },
  };
}

export default defineConfig({
  // Capacitor serves dist/ from https://localhost/, but relative paths keep the build portable.
  base: './',
  resolve: {
    alias: { '@web': WEB_SRC },
  },
  server: {
    host: true,
    port: 5174,
    // Allow importing ../../web/src.
    fs: { allow: [REPO_ROOT] },
    proxy: {
      ...apiProxy('/proxy/adsb.lol', 'https://api.adsb.lol'),
      ...apiProxy('/proxy/adsb.im', 'https://adsb.im'),
    },
  },
});
