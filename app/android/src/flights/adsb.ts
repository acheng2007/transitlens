// Port of flight-service/app/adsb.py: adsb.lol nearby aircraft + best-effort route lookup, both cached.
//
// On the phone, fetch() is patched by CapacitorHttp and goes through native HTTP: api.adsb.lol sends
// no CORS headers, and native requests can set the User-Agent it checks. In a desktop browser
// (npm run dev) requests go through Vite's dev proxy instead. In Node (scripts/check-flights.mjs)
// they go straight to the API.

import type { Plane } from '@web/planes';
import { haversineKm } from './geo';
import type { RawAircraft } from './normalize';

const IS_NATIVE = Boolean((globalThis as any).Capacitor?.isNativePlatform?.());
const VIA_DEV_PROXY = typeof window !== 'undefined' && !IS_NATIVE;
const ADSB_LOL = VIA_DEV_PROXY ? '/proxy/adsb.lol' : 'https://api.adsb.lol';
const ADSB_IM = VIA_DEV_PROXY ? '/proxy/adsb.im' : 'https://adsb.im';

// api.adsb.lol/api/0/routeset currently returns an empty 201; adsb.im serves the same data.
const ROUTESET_URLS = [`${ADSB_IM}/api/0/routeset`, `${ADSB_LOL}/api/0/routeset`];
const MAX_RADIUS_NM = 250;
// Generous: when a client polls a lot, adsb.lol's rate limiter answers slowly (seen on a phone:
// 2.5–7 s per request while the same URL took 0.5 s elsewhere). Giving up early doesn't help,
// since the server still counts the request, so wait for the answer and let the feed slow down.
const TIMEOUT_MS = 15_000;
// adsb.lol 403s generic client User-Agents.
export const USER_AGENT = 'SkyLens/0.1 (Android; hackathon)';

const POINT_TTL_MS = 1000; // shorter than the feed's 5 s poll, so every poll gets fresh data
const ROUTE_TTL_MS = 30 * 60 * 1000;
/** Callsigns the route service didn't return at all: retry later, but not on every poll. */
const ROUTE_MISS_TTL_MS = 5 * 60 * 1000;

// Query center is snapped to a ~1 km grid (2 decimals) so GPS jitter doesn't create a new cache key
// (and a new upstream call) every poll. Callers recompute distance/bearing from the exact position
// and trim to the real radius; nearby.ts adds a 1 nm margin to cover the snap.
const KEY_DECIMALS = 2;
// adsb.lol rate-limits (429). Back off for Retry-After seconds (default below) instead of retrying.
// adsb.lol sends no Retry-After, so the default applies. The live feed also slows its own polling
// after a 429 (feed.ts), which is what actually finds a sustainable rate.
const RATE_LIMIT_BACKOFF_MS = 5000;

/** Tiny in-memory TTL cache (flight-service/app/cache.py). */
class TTLCache<V> {
  private data = new Map<string, { at: number; ttl: number; value: V }>();
  constructor(private ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.data.get(key);
    return hit && Date.now() - hit.at <= hit.ttl ? hit.value : undefined;
  }

  /** The value even if expired (fallback when upstream is down). */
  getStale(key: string): V | undefined {
    return this.data.get(key)?.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    this.data.set(key, { at: Date.now(), ttl: ttlMs, value });
  }
}

/** [origin, destination] airport codes (IATA preferred); [null, null] = looked up, unknown. */
export type Route = [string | null, string | null];

/** Aircraft from one successful adsb.lol response, and when it was fetched (Date.now() ms). */
type PointData = { ac: RawAircraft[]; fetchedAt: number };

const pointCache = new TTLCache<PointData>(POINT_TTL_MS);
const routeCache = new TTLCache<Route>(ROUTE_TTL_MS);
let cooldownUntil = 0;
/** Most recent successful response for any key: shown instead of an empty sky when upstream fails. */
let lastGood: PointData | null = null;

export type PointResult = PointData & {
  /** null = fresh data; otherwise why cached/last-good data was returned. fetchedAt says how old it is. */
  problem: null | 'rate-limited' | 'unreachable';
};

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  });
  const headers = { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) };
  try {
    return await Promise.race([fetch(url, { ...init, headers }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMs(r: Response): number {
  const s = Number(r.headers.get('retry-after') ?? RATE_LIMIT_BACKOFF_MS / 1000);
  return Number.isFinite(s) ? Math.max(1, Math.min(60, s)) * 1000 : RATE_LIMIT_BACKOFF_MS;
}

/** Raw readsb aircraft within radiusNm. Never throws: falls back to cached / last good data. */
export async function fetchPoint(lat: number, lon: number, radiusNm: number): Promise<PointResult> {
  const nm = Math.max(1, Math.min(MAX_RADIUS_NM, Math.round(radiusNm)));
  const qlat = lat.toFixed(KEY_DECIMALS);
  const qlon = lon.toFixed(KEY_DECIMALS);
  const key = `${qlat},${qlon},${nm}`;
  const cached = pointCache.get(key);
  if (cached) return { ...cached, problem: null };
  const fallback = pointCache.getStale(key) ?? lastGood ?? { ac: [], fetchedAt: Date.now() };
  if (Date.now() < cooldownUntil) return { ...fallback, problem: 'rate-limited' };
  try {
    const r = await request(`${ADSB_LOL}/v2/point/${Number(qlat).toFixed(4)}/${Number(qlon).toFixed(4)}/${nm}`);
    if (r.status === 429) {
      const wait = retryAfterMs(r);
      cooldownUntil = Date.now() + wait;
      console.warn(`adsb.lol rate limited (429); backing off ${wait / 1000} s`);
      return { ...fallback, problem: 'rate-limited' };
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { ac?: RawAircraft[] | null };
    const data: PointData = { ac: body.ac ?? [], fetchedAt: Date.now() };
    pointCache.set(key, data);
    lastGood = data;
    return { ...data, problem: null };
  } catch (e) {
    console.warn('adsb.lol point fetch failed:', e);
    return { ...fallback, problem: 'unreachable' };
  }
}

type Airport = { lat?: number | null; lon?: number | null; iata?: string | null; icao?: string | null };
type RouteEntry = { callsign?: string; plausible?: unknown; _airports?: Airport[] | null };

export function parseRoute(entry: RouteEntry, lat?: number, lon?: number): Route {
  if (!entry.plausible) return [null, null];
  const airports = (entry._airports ?? []).filter(
    (a): a is Airport & { lat: number; lon: number } => a.lat != null && a.lon != null,
  );
  const codes = airports.map((a) => a.iata || a.icao || null);
  if (airports.length < 2 || !codes.every(Boolean)) return [null, null];
  if (airports.length === 2 || lat == null || lon == null) return [codes[0], codes[1]];
  // Multi-leg (e.g. ATL-MIA-ATL): pick the leg with the smallest detour via the plane's position.
  const detour = (i: number) => {
    const [a, b] = [airports[i], airports[i + 1]];
    return haversineKm(a.lat, a.lon, lat, lon) + haversineKm(lat, lon, b.lat, b.lon) - haversineKm(a.lat, a.lon, b.lat, b.lon);
  };
  let best = 0;
  for (let i = 1; i < airports.length - 1; i++) if (detour(i) < detour(best)) best = i;
  return [codes[best], codes[best + 1]];
}

/** Cached route for a callsign, or undefined if it hasn't been looked up (or the entry expired). */
export const cachedRoute = (callsign: string): Route | undefined => routeCache.get(callsign);

/**
 * Looks up routes for planes whose callsign isn't cached yet and fills the cache.
 * Best effort, never throws. Unlike flight-service this runs in the background: planes show up
 * right away and origin/destination fill in on the next poll.
 */
export async function lookupRoutes(planes: Plane[]): Promise<void> {
  const missing = new Map<string, { callsign: string; lat: number; lng: number }>();
  for (const p of planes) {
    if (p.callsign && !missing.has(p.callsign) && !routeCache.get(p.callsign)) {
      missing.set(p.callsign, { callsign: p.callsign, lat: p.lat, lng: p.lon });
    }
  }
  if (missing.size === 0) return;

  for (const url of ROUTESET_URLS) {
    try {
      const r = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planes: [...missing.values()] }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const data: unknown = text ? JSON.parse(text) : null;
      if (!Array.isArray(data)) continue;
      for (const entry of data as RouteEntry[]) {
        const cs = (entry.callsign ?? '').trim();
        if (!cs) continue;
        const pos = missing.get(cs);
        routeCache.set(cs, parseRoute(entry, pos?.lat, pos?.lng));
        missing.delete(cs);
      }
      for (const cs of missing.keys()) routeCache.set(cs, [null, null], ROUTE_MISS_TTL_MS);
      return;
    } catch (e) {
      console.warn(`routeset lookup failed at ${url}:`, e);
    }
  }
}
