#!/usr/bin/env node
// `npm run phone`: opens a public HTTPS tunnel to the dev server and prints a QR code to scan.
// Phones need HTTPS for the camera, GPS and compass; a plain LAN address won't work.
//
// Uses a Cloudflare quick tunnel (free, no account). Install cloudflared once:
//   macOS: brew install cloudflared   Windows: winget install Cloudflare.cloudflared
// The URL changes every time this restarts. The laptop's start screen shows the same QR code.

import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const PORT = 5173;
const URL_FILE = fileURLToPath(new URL('../.phone-url', import.meta.url));

async function check(url, label, fix) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return true;
  } catch {}
  console.log(`\x1b[33m!\x1b[0m ${label} isn't answering. ${fix}`);
  return false;
}

await check(`http://127.0.0.1:${PORT}/`, `Web dev server (port ${PORT})`, 'Run `npm run dev` in web/.');
await check(
  `http://127.0.0.1:${PORT}/api/buses/nearby?lat=29.6465&lon=-82.3478&radiusKm=1`,
  'Bus service (port 8003)',
  'Start it from bus-service/ (see its README); the app will show no buses until then.',
);

console.log('Opening an HTTPS tunnel…');
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
tunnel.on('error', () => {
  console.error('\x1b[31mcloudflared not found.\x1b[0m Install it (macOS: brew install cloudflared · Windows: winget install Cloudflare.cloudflared) and try again.');
  process.exit(1);
});

let shown = false;
const onOutput = async (chunk) => {
  const match = !shown && /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
  if (!match) return;
  shown = true;
  const url = match[0];
  writeFileSync(URL_FILE, url);
  // Quick tunnels take a while (DNS) before they route; wait so the first scan works.
  console.log('Waiting for the link to go live (up to a minute)…');
  let live = false;
  for (let i = 0; i < 30 && !live; i++) {
    try {
      live = (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {}
    if (!live) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!live) console.log('\x1b[33m!\x1b[0m The link isn\'t answering yet from this computer; it usually works on the phone within a minute.');
  console.log('\n' + (await QRCode.toString(url, { type: 'terminal', small: true })));
  console.log(`  \x1b[1m${url}\x1b[0m\n`);
  console.log('  Scan with the iPhone Camera app (or Android camera) and open in Safari/Chrome.');
  console.log('  Tip: Share → Add to Home Screen to open it full screen like an app.');
  console.log('  The laptop start screen (http://localhost:5173) shows this QR code too.');
  console.log('  Keep this running. Ctrl+C to stop.\n');
};
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);

const cleanup = () => {
  rmSync(URL_FILE, { force: true });
  tunnel.kill();
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
tunnel.on('exit', (code) => {
  rmSync(URL_FILE, { force: true });
  if (code) console.error(`cloudflared exited (${code}).`);
  process.exit(code ?? 0);
});
