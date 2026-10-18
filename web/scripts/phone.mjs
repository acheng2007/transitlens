#!/usr/bin/env node
// `npm run phone`: opens a public HTTPS tunnel to the dev server and prints a QR code to scan.
// Phones need HTTPS for the camera, GPS and compass; a plain LAN address won't work.
//
// Tunnel provider:
//   ngrok (preferred when logged in): uses the normal HTTPS port, which campus/managed networks allow.
//     One-time: create a free account, then `ngrok config add-authtoken <token>`.
//     Set NGROK_DOMAIN=<your-free-static-domain> for a link (and QR code) that never changes.
//   Cloudflare quick tunnel (fallback, no account): brew install cloudflared / winget install Cloudflare.cloudflared.
//     Its URL changes on every restart, and some networks stall its port 7844 traffic.
// Force one with PHONE_TUNNEL=ngrok or PHONE_TUNNEL=cloudflare. The laptop's start screen shows the same QR code.
// Tunnels can lose their link while running; a watchdog checks it every
// 20 s and opens a fresh tunnel (new URL + QR code) after three failures in a row.

import { spawn, spawnSync } from 'node:child_process';
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

/** ngrok when it's logged in (config has an authtoken), unless PHONE_TUNNEL says otherwise. */
const ngrokReady = () => spawnSync('ngrok', ['config', 'check'], { stdio: 'ignore' }).status === 0;
const PROVIDER = process.env.PHONE_TUNNEL ?? (ngrokReady() ? 'ngrok' : 'cloudflare');
console.log(`Tunnel: ${PROVIDER}${PROVIDER === 'cloudflare' ? " (log in to ngrok for a more reliable link: see the top of scripts/phone.mjs)" : ''}`);

const WATCH_MS = 20_000;
const MAX_FAILURES = 3;
/** New links get this long to start resolving before the watchdog counts failures. */
const GRACE_MS = 120_000;

let tunnel = null;
let url = null;
let failures = 0;
let stopping = false;
let openedAt = 0;
let answeredOnce = false;

async function isLive(link) {
  try {
    return (await fetch(link, { signal: AbortSignal.timeout(8000) })).ok;
  } catch {
    return false;
  }
}

async function announce(link) {
  writeFileSync(URL_FILE, link);
  // Quick tunnels take a while (DNS) before they route; wait so the first scan works.
  console.log('Waiting for the link to go live (up to a minute)…');
  let live = false;
  for (let i = 0; i < 30 && !live && url === link; i++) {
    live = await isLive(link);
    if (!live) await new Promise((r) => setTimeout(r, 2000));
  }
  if (url !== link) return;
  if (!live) console.log("\x1b[33m!\x1b[0m The link isn't answering yet from this computer; it usually works on the phone within a minute.");
  console.log('\n' + (await QRCode.toString(link, { type: 'terminal', small: true })));
  console.log(`  \x1b[1m${link}\x1b[0m\n`);
  console.log('  Scan with the iPhone Camera app (or Android camera) and open in Safari/Chrome.');
  console.log('  Tip: Share → Add to Home Screen to open it full screen like an app.');
  console.log('  The laptop start screen (http://localhost:5173) shows this QR code too.');
  console.log('  Keep this running. Ctrl+C to stop.\n');
}

function openTunnel() {
  console.log('Opening an HTTPS tunnel…');
  url = null;
  failures = 0;
  answeredOnce = false;
  openedAt = Date.now();
  const proc = PROVIDER === 'ngrok'
    ? spawn('ngrok', ['http', String(PORT), '--log', 'stdout', '--log-format', 'json', ...(process.env.NGROK_DOMAIN ? ['--url', process.env.NGROK_DOMAIN] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnel = proc;
  proc.on('error', () => {
    console.error(PROVIDER === 'ngrok'
      ? '\x1b[31mngrok not found.\x1b[0m Install it (macOS: brew install ngrok · Windows: winget install ngrok.ngrok).'
      : '\x1b[31mcloudflared not found.\x1b[0m Install it (macOS: brew install cloudflared · Windows: winget install Cloudflare.cloudflared) and try again.');
    process.exit(1);
  });
  const onOutput = (chunk) => {
    const text = chunk.toString();
    if (PROVIDER === 'ngrok' && /ERR_NGROK|"lvl":"(eror|crit)"/.test(text)) {
      const msg = /"err":"([^"]+)"/.exec(text)?.[1];
      if (msg) console.error(`\x1b[31mngrok:\x1b[0m ${msg.slice(0, 300)}`);
    }
    const match = !url && tunnel === proc && (PROVIDER === 'ngrok'
      ? /"url":"(https:\/\/[^"]+)"/.exec(text)?.slice(1)
      : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text));
    if (!match) return;
    url = match[0];
    void announce(url);
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);
  proc.on('exit', (code) => {
    if (stopping || tunnel !== proc) return;
    console.error(`cloudflared exited (${code ?? 'signal'}); reopening…`);
    rmSync(URL_FILE, { force: true });
    setTimeout(openTunnel, 2000);
  });
}

function restartTunnel(reason) {
  console.log(`\x1b[33m!\x1b[0m ${reason} Opening a new tunnel; scan the new QR code.`);
  rmSync(URL_FILE, { force: true });
  const old = tunnel;
  tunnel = null;
  old?.kill();
  openTunnel();
}

// Watchdog: the link must keep answering. (Started links get a minute of grace in announce().)
setInterval(async () => {
  const link = url;
  if (!link || stopping) return;
  if (await isLive(link)) {
    failures = 0;
    answeredOnce = true;
    return;
  }
  if (url !== link || (!answeredOnce && Date.now() - openedAt < GRACE_MS)) return;
  failures += 1;
  if (failures >= MAX_FAILURES) restartTunnel(`The link ${link} stopped answering.`);
}, WATCH_MS);

const cleanup = () => {
  stopping = true;
  rmSync(URL_FILE, { force: true });
  tunnel?.kill();
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

openTunnel();
