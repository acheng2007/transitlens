import type { Bus, PatternStop, TransitPattern } from '../../shared/transit';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_PATTERNS = 64;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableText = (value: unknown) => (typeof value === 'string' && value ? value : null);
const validPosition = (lat: unknown, lon: unknown) => finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Validate `/api/transit/patterns/{id}` so malformed data draws nothing rather than an invented line. */
export function parsePattern(value: unknown): TransitPattern | null {
  const body = (value as { pattern?: Record<string, unknown> } | null)?.pattern;
  if (!body || typeof body.id !== 'string' || typeof body.routeId !== 'string' || !Array.isArray(body.points) || !Array.isArray(body.stops)) return null;
  const points = body.points.filter((p): p is [number, number] => Array.isArray(p) && validPosition(p[0], p[1]));
  if (points.length < 2) return null;
  const stops = body.stops.filter((s): s is PatternStop => !!s && typeof s.id === 'string' && validPosition(s.lat, s.lon))
    .map((s, sequence) => ({ id: s.id, name: typeof s.name === 'string' ? s.name : s.id, lat: s.lat, lon: s.lon, sequence, distanceKm: finite(s.distanceKm) ? s.distanceKm : null }));
  const color = nullableText(body.routeColor);
  return {
    id: body.id, routeId: body.routeId, routeDisplay: nullableText(body.routeDisplay) ?? body.routeId,
    routeName: nullableText(body.routeName), routeColor: color && HEX_COLOR.test(color) ? color : null,
    direction: nullableText(body.direction), lengthKm: finite(body.lengthKm) ? body.lengthKm : null,
    detour: body.detour === true, points: points.map(([lat, lon]) => [lat, lon]), stops,
  };
}

type Fetcher = (id: string, signal: AbortSignal) => Promise<unknown>;
const fetchPattern: Fetcher = async (id, signal) => {
  const res = await fetch(`/api/transit/patterns/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`pattern ${res.status}`);
  return res.json();
};

/**
 * Patterns change rarely, so each ID is fetched once per session with no polling.
 * A failed or malformed response is retried after `retryMs`.
 */
export function createPatternCache(fetcher: Fetcher = fetchPattern, retryMs = 60000) {
  const controller = new AbortController();
  const entries = new Map<string, { pattern: TransitPattern | null; pending: boolean; failedAt: number }>();
  return {
    get(id: string, now = performance.now()): TransitPattern | null {
      const entry = entries.get(id);
      if (entry?.pattern || entry?.pending || (entry && now - entry.failedAt < retryMs) || controller.signal.aborted) return entry?.pattern ?? null;
      const next = { pattern: null as TransitPattern | null, pending: true, failedAt: -Infinity };
      entries.delete(id);
      entries.set(id, next);
      if (entries.size > MAX_PATTERNS) entries.delete(entries.keys().next().value!);
      fetcher(id, controller.signal)
        .then(data => { next.pattern = parsePattern(data); if (!next.pattern || next.pattern.id !== id) throw new Error('invalid pattern'); })
        .catch(() => { next.pattern = null; next.failedAt = now; })
        .finally(() => { next.pending = false; });
      return null;
    },
    stop() { controller.abort(); entries.clear(); },
  };
}

/**
 * Chooses the pattern to draw from the shared focused bus. The last route stays for
 * `holdMs` after focus is lost so heading jitter does not flicker it, but a newly
 * focused bus without a pattern clears it immediately so it never shows the wrong route.
 */
export function createRouteSelection(holdMs = 3000) {
  let patternId: string | null = null;
  let lostAt: number | null = null;
  return {
    update(focus: Bus | null, timeMs: number): string | null {
      if (focus) {
        patternId = focus.patternId ?? null;
        lostAt = null;
      } else if (patternId !== null) {
        lostAt ??= timeMs;
        if (timeMs - lostAt >= holdMs) { patternId = null; lostAt = null; }
      }
      return patternId;
    },
  };
}
