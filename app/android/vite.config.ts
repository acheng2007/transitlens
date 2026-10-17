import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const WEB_SRC = fileURLToPath(new URL('../../web/src', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  base: './',
  resolve: { alias: { '@web': WEB_SRC } },
  server: {
    host: true,
    port: 5174,
    fs: { allow: [REPO_ROOT] },
    proxy: { '/api/buses': 'http://127.0.0.1:8003' },
  },
});
