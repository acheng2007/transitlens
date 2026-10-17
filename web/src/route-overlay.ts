import type { TransitPattern } from '../../shared/transit';

const FALLBACK_COLOR = '#ffc94d';

/**
 * Draws a pattern's reported geometry and stops into the map buffer. `project` must be
 * the same projection used for bus markers so the line and vehicles stay aligned.
 */
export function drawRoutePattern(
  ctx: CanvasRenderingContext2D,
  pattern: TransitPattern,
  project: (lat: number, lon: number) => [number, number],
  compact: boolean,
) {
  const color = pattern.routeColor ?? FALLBACK_COLOR;
  const width = compact ? 9 : 6;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (pattern.detour) ctx.setLineDash([width * 2, width * 1.5]);
  ctx.beginPath();
  pattern.points.forEach(([lat, lon], i) => {
    const [x, y] = project(lat, lon);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(8, 18, 28, 0.85)';
  ctx.lineWidth = width + 5;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.setLineDash([]);
  const radius = compact ? 6 : 4.5;
  // Skip stops that would overlap the previous dot so wide zooms stay readable.
  let last: [number, number] | null = null;
  for (const stop of pattern.stops) {
    const [x, y] = project(stop.lat, stop.lon);
    if (last && Math.hypot(x - last[0], y - last[1]) < radius * 3.5) continue;
    last = [x, y];
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.restore();
}
