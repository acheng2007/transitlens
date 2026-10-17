// Checks the in-app flight engine (src/flights, TypeScript) against flight-service (Python):
// both get the same input, and every plane field has to match.
//
//   npm run check            flight-service's frozen snapshot (flight-service/data), offline. The app
//                            has no demo mode; the snapshot is just a fixed, real-world input.
//   npm run check -- --live  also fetches live adsb.lol data around Georgia Tech (through the TS
//                            engine), compares normalization on it, and runs a real route lookup
//
// Needs flight-service/.venv (pip install -r flight-service/requirements.txt). No server needed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const LIVE = process.argv.includes('--live');
const GT = { lat: 33.7756, lon: -84.3963 };
const LIVE_RADIUS_KM = 25;
/** Same center/radius flight-service's demo mode uses for this snapshot (app/demo.py). */
const SNAPSHOT_RADIUS_KM = 40;

// Rounded to 3 / 2 decimals on both sides; allow one unit of rounding difference.
const TOLERANCE = { distanceKm: 0.0011, bearingDeg: 0.011 };

const PYTHON_SRC = `
import json, sys
sys.path.insert(0, "flight-service")
from app import demo
from app.main import build_planes, apply_routes
req = json.load(sys.stdin)
if req["mode"] == "demo":
    snap = demo.load_snapshot()
    planes = build_planes(snap["ac"], demo.DEMO_LAT, demo.DEMO_LON, demo.DEMO_RADIUS_KM, None, 360)
    apply_routes(planes, snap.get("routes", {}))
else:
    planes = build_planes(req["raw"], req["lat"], req["lon"], req["radiusKm"], None, 360)
sys.stdout.write(json.dumps(planes))
`;

function python(request) {
  const venv = ['flight-service/.venv/Scripts/python.exe', 'flight-service/.venv/bin/python']
    .map((p) => `${ROOT}${p}`)
    .find((p) => existsSync(p));
  const r = spawnSync(venv ?? 'python', ['-c', PYTHON_SRC], {
    cwd: ROOT,
    input: JSON.stringify(request),
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`python failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Returns a list of mismatch descriptions (empty = identical). */
function compare(label, ts, py) {
  const problems = [];
  if (ts.length !== py.length) problems.push(`${label}: ${ts.length} planes in TS vs ${py.length} in Python`);
  const pyById = new Map(py.map((p) => [p.id, p]));
  for (const t of ts) {
    const p = pyById.get(t.id);
    if (!p) {
      problems.push(`${label}: ${t.id} only in TS`);
      continue;
    }
    const keys = new Set([...Object.keys(t), ...Object.keys(p)]);
    for (const k of keys) {
      const [a, b] = [t[k], p[k]];
      const ok = k in TOLERANCE ? Math.abs(a - b) <= TOLERANCE[k] : JSON.stringify(a) === JSON.stringify(b);
      if (!ok) problems.push(`${label}: ${t.id}.${k} TS=${JSON.stringify(a)} Python=${JSON.stringify(b)}`);
    }
  }
  const tsOrder = ts.map((p) => p.id).join();
  const pyOrder = py.map((p) => p.id).join();
  if (!problems.length && tsOrder !== pyOrder) problems.push(`${label}: same planes, different sort order`);
  return problems;
}

function report(label, planes, problems) {
  const routes = planes.filter((p) => p.origin || p.destination).length;
  const heli = planes.filter((p) => p.kind === 'helicopter').length;
  const status = problems.length ? `FAIL (${problems.length} mismatches)` : 'OK';
  console.log(`${label}: ${planes.length} planes, ${routes} with routes, ${heli} helicopters -> ${status}`);
  for (const line of problems.slice(0, 20)) console.log(`  ${line}`);
}

const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
});
let failed = false;
try {
  const nearby = await vite.ssrLoadModule('/src/flights/nearby.ts');
  const adsb = await vite.ssrLoadModule('/src/flights/adsb.ts');

  const snap = JSON.parse(readFileSync(`${ROOT}flight-service/data/demo-snapshot.json`, 'utf-8'));
  const snapTs = nearby.buildPlanes(snap.ac, GT.lat, GT.lon, SNAPSHOT_RADIUS_KM);
  nearby.applyRoutes(snapTs, (cs) => snap.routes[cs]);
  const snapProblems = compare('snapshot', snapTs, python({ mode: 'demo' }));
  report('snapshot', snapTs, snapProblems);
  failed ||= snapProblems.length > 0;

  if (LIVE) {
    const { ac, problem } = await adsb.fetchPoint(GT.lat, GT.lon, LIVE_RADIUS_KM / 1.852 + 1);
    if (problem) throw new Error(`live fetch failed: ${problem}`);
    const liveTs = nearby.buildPlanes(ac, GT.lat, GT.lon, LIVE_RADIUS_KM);
    const liveProblems = compare('live', liveTs, python({ mode: 'live', raw: ac, ...GT, radiusKm: LIVE_RADIUS_KM }));
    report(`live adsb.lol (${ac.length} raw)`, liveTs, liveProblems);
    failed ||= liveProblems.length > 0;

    await adsb.lookupRoutes(liveTs);
    nearby.applyRoutes(liveTs, adsb.cachedRoute);
    const withCallsign = liveTs.filter((p) => p.callsign);
    const routed = liveTs.filter((p) => p.origin && p.destination);
    console.log(`route lookup: ${routed.length}/${withCallsign.length} callsigns resolved`);
    for (const p of routed.slice(0, 5)) {
      console.log(`  ${p.callsign.padEnd(8)} ${p.origin} -> ${p.destination}  ${p.typeName ?? p.typeCode ?? ''}`);
    }
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await vite.close();
}
// exitCode, not process.exit(): exiting while Vite's handles close trips a libuv assertion on Windows.
process.exitCode = failed ? 1 : 0;
