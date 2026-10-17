// Live plane feed for the HUD: same PlaneFeed/FeedState interface as web/src/planes.ts, but the
// data comes from the in-app engine (nearby.ts) instead of flight-service. (No demo mode: the app
// always shows live traffic around the phone's GPS position.)

import type { Plane } from '@web/planes';
import type { FeedState, LatLon, PlaneFeed } from '@web/planes';
import { toRad } from '@web/geo';
import { bearingDeg, haversineKm } from './geo';
import { livePlanes } from './nearby';

/**
 * adsb.lol rate-limits per IP, and the limit varies. Measured on a Galaxy S22+ (2026-09-29):
 * a fixed 1 s poll got 11 of 13 requests rejected (429), and a fixed 5 s poll still got 7 of 12.
 * A throttled client also gets slow answers (seconds) before any 429. So the poll interval adapts:
 * ×1.5 after a 429, a failure or a slow answer; −1 s after a quick success; within these bounds.
 * That settles near the rate adsb.lol currently allows, including with several phones behind one IP.
 */
const MIN_POLL_MS = 5000;
const MAX_POLL_MS = 30_000;
/** An answer slower than this means adsb.lol is throttling us: back off like on a 429. */
const SLOW_ANSWER_MS = 3000;
/** How often to check for the first GPS fix. */
const GPS_WAIT_POLL_MS = 1000;

/** Between polls, airborne planes are moved along their track (dead reckoning), up to this long. */
const MAX_EXTRAPOLATE_S = 60;
/** Recompute extrapolated positions at most this often (get() is called every frame). */
const EXTRAPOLATE_EVERY_MS = 100;
const KM_PER_DEG_LAT = 111.32;
const KM_PER_NM = 1.852;

/**
 * Where each plane is now: moved from its reported position along trackDeg at groundSpeedKt for the
 * time since the data was fetched, with distance/bearing recomputed from the viewer's position.
 * Planes on the ground or without speed/track stay put. Flat-earth step: fine for < ~15 km moves.
 */
function extrapolate(planes: Plane[], fetchedAt: number, now: number, viewer: LatLon): Plane[] {
  const hours = Math.min(MAX_EXTRAPOLATE_S, Math.max(0, (now - fetchedAt) / 1000)) / 3600;
  return planes.map((p) => {
    let { lat, lon } = p;
    if (!p.onGround && p.groundSpeedKt && p.trackDeg != null) {
      const km = p.groundSpeedKt * KM_PER_NM * hours;
      const t = toRad(p.trackDeg);
      lat += (km * Math.cos(t)) / KM_PER_DEG_LAT;
      lon += (km * Math.sin(t)) / (KM_PER_DEG_LAT * Math.cos(toRad(lat)));
    }
    return {
      ...p,
      lat,
      lon,
      distanceKm: haversineKm(viewer.lat, viewer.lon, lat, lon),
      bearingDeg: bearingDeg(viewer.lat, viewer.lon, lat, lon),
    };
  });
}

/**
 * Polls adsb.lol around the GPS position with an adaptive interval (see MIN_POLL_MS), starting each
 * poll after the previous one finishes so slow responses never pile up. On failure it keeps the
 * last good data. Positions are extrapolated between polls so planes glide instead of jumping.
 */
export function startLiveFeed(opts: { radiusKm: number | null; getPosition: () => LatLon | null }): PlaneFeed {
  let status = 'live · waiting for GPS';
  let polled: { planes: Plane[]; fetchedAt: number; at: LatLon } | null = null;
  let current: FeedState = { planes: [], status };
  let computedAt = 0;
  let interval = MIN_POLL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll() {
    const pos = opts.getPosition();
    if (!pos) {
      // No fix yet: check again soon so planes appear as soon as GPS locks (no network call here).
      status = 'live · waiting for GPS';
      if (!stopped) timer = setTimeout(poll, GPS_WAIT_POLL_MS);
      return;
    }
    const startedAt = Date.now();
    const { planes, problem, fetchedAt } = await livePlanes(pos.lat, pos.lon, opts.radiusKm);
    if (stopped) return;
    polled = { planes, fetchedAt, at: pos };
    computedAt = 0; // recompute on the next get()
    const throttled = problem != null || Date.now() - startedAt > SLOW_ANSWER_MS;
    interval = throttled ? Math.min(MAX_POLL_MS, interval * 1.5) : Math.max(MIN_POLL_MS, interval - 1000);
    const age = Math.round((Date.now() - fetchedAt) / 1000);
    status =
      problem === 'rate-limited'
        ? `live · rate limited · ${planes.length} cached (${age} s old)`
        : problem === 'unreachable'
          ? `live · adsb.lol unreachable · ${planes.length} cached (${age} s old)`
          : `live · ${planes.length} planes`;
    status += ` · every ${Math.round(interval / 1000)} s`;
    timer = setTimeout(poll, interval);
  }

  poll();
  return {
    get: () => {
      const now = Date.now();
      if (now - computedAt >= EXTRAPOLATE_EVERY_MS) {
        computedAt = now;
        const planes = polled ? extrapolate(polled.planes, polled.fetchedAt, now, opts.getPosition() ?? polled.at) : [];
        current = { planes, status };
      }
      return current;
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
