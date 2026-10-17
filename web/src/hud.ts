// Per-frame HUD drawn on a canvas. The same draw call runs once per eye so both eyes
// always show identical content (required for the two images to fuse in the headset).
//
// Everything hangs off one "headband" compass bar near the top of the view:
//   on the bar:    a plane or helicopter icon per aircraft at its bearing, center mark
//   below the bar: degree ticks/labels, current heading
//   right under that: info card for the focused plane, attached to the compass
//                  (drops down like a notification)
// Voice ("hey grok") status and answers show as subtitles near the bottom.
// Transit receives a shared street-map frame; the native aircraft renderer retains its radar.
// The middle of the view stays clear.

import { aircraftStatus, busCard, cardLines, flightLabel, statusTag } from './format';
import type { AircraftStatus } from './format';
import { halfFovDeg, normalizeDeg, projectX, signedDiffDeg } from './geo';
import type { Plane } from './planes';
import type { MapFrame } from './street-map';
import type { Bus } from './buses';
type Target = Plane | Bus;
import type { VoiceState } from './voice';

/** What the voice subtitles show. Timing (when to clear the answer) is handled by main.ts. */
export type VoiceHud = {
  state: VoiceState;
  transcript: string | null;
  answer: string | null;
  error: string | null;
};

/** Planes the viewer is looking at this frame (offsetDeg filled in), for voice context. */
export type HudResult<T = Plane> = {
  focus: T | null;
  inView: T[];
};

const NO_PLANES: HudResult<never> = { focus: null, inView: [] };

export type HudState<T = Plane> = {
  headingDeg: number | null;
  /** tan(half horizontal FOV) of what one eye shows. */
  halfTan: number;
  planes: T[];
  /** Shared bus selection, computed once before either eye or casting draws. */
  selectedFocusId?: string | null;
  mapFrame?: MapFrame | null;
  expandedMap?: boolean;
  /** Data feed status, shown when there are no planes at all (e.g. "live · waiting for GPS"). */
  status: string;
  /** Frame timestamp (same for both eyes) for animations. */
  timeMs: number;
  /** null = voice disabled. */
  voice: VoiceHud | null;
  /** Transit: when the current selection began (shared, so both eyes animate together). */
  focusSinceMs?: number;
  /** Transit: bus dwelling in the focus cone and its dwell progress 0..1. */
  dwellId?: string | null;
  dwellProgress?: number;
};

const COLORS = {
  hud: 'rgba(79, 195, 247, 0.95)',
  hudDim: 'rgba(79, 195, 247, 0.55)',
  focus: '#ffc94d',
  text: '#ffffff',
  panel: 'rgba(0, 0, 0, 0.62)',
  shadow: 'rgba(0, 0, 0, 0.8)',
};

/**
 * Transit design tokens (mirror the CSS variables in style.css). Panels are near-opaque and unblurred
 * so text stays sharp through the lenses and readable over a bright outdoor camera image.
 */
const T = {
  primary: '#a7b8ff',
  primaryDim: 'rgba(167, 184, 255, 0.55)',
  primaryFaint: 'rgba(167, 184, 255, 0.28)',
  secondary: '#8ce7db',
  secondaryGlow: 'rgba(140, 231, 219, 0.65)',
  text: '#f8fafc',
  muted: '#c6cddb',
  warning: '#ffcf7a',
  glass: 'rgba(14, 19, 34, 0.82)',
  glassBorder: 'rgba(255, 255, 255, 0.16)',
  onAccent: '#0b1020',
  shadow: 'rgba(0, 0, 0, 0.6)',
};
/** Card fade/slide-in after a bus is selected. */
const BUS_CARD_ANIM_MS = 220;

/** Icon/accent color per aircraft status (normal planes use the HUD blue, focus adds yellow). */
const STATUS_COLORS: Record<AircraftStatus, string> = {
  emergency: '#ff3b30',
  ground: '#9e9e9e',
  medical: '#c77dff',
  military: '#4cd964',
  normal: COLORS.hud,
};
/** Emergency blink: on/off period in ms. */
const BLINK_MS = 400;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Global text size multiplier; tune here if text is too big/small in the headset. */
const TEXT_SCALE = 0.8;
const fs = (px: number) => Math.round(px * TEXT_SCALE * 10) / 10;

/** Vertical position of the compass bar (fraction of eye height). The lenses hide the very top. */
const COMPASS_Y = 0.24;
/** Compass bar spans this fraction of the eye width, centered (the lenses hide the edges). */
const COMPASS_WIDTH = 0.7;
/** A plane gets the info card only when it's within this angle of center (15° total cone). */
export const FOCUS_HALF_DEG = 7.5;
/** Card pop-up animation length. */
const CARD_ANIM_MS = 180;

// Tracks when the current focus plane became focused, for the pop-up animation.
let focusAnim: { id: string; since: number } | null = null;

/** Subtitle area for voice: bottom edge of the answer panel (fraction of eye height). */
const VOICE_Y = 0.84;
/** How long the idle "Say Hey Grok" hint stays after start (ms). */
const HINT_MS = 15000;

export function drawHud(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState<Bus>): HudResult<Bus>;
export function drawHud(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState): HudResult;
export function drawHud(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState<Target>): HudResult<Target> {
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  const result = drawPlanes(ctx, w, h, s);
  // Transit map frames remain independent of compass filtering and voice status.
  if (s.mapFrame) drawStreetMap(ctx, w, h, s.mapFrame);
  else if (s.headingDeg != null) {
    drawRadar(ctx, w, h, s, s.headingDeg, result.focus?.id ?? null);
  }
  if (s.selectedFocusId !== undefined) drawStatus(ctx, w, h, s.status);
  if (s.voice) drawVoice(ctx, w, h, s.voice, s.timeMs);
  return result;
}

/** Radar center (fractions of eye width/height) and radius (fraction of eye width). Kept inward: lens edges blur. */
const RADAR_X = 0.26;
const RADAR_Y = 0.7;
const RADAR_R = 0.1;
/** Radar range snaps to the smallest of these that fits the farthest plane (km). */
const RADAR_RANGES_KM = [0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 40, 60, 80, 120];

/**
 * Heading-up radar: you're at the center, your view cone points up, planes are dots at their true
 * direction and distance (colored by status, focused plane yellow), and N/E/S/W orbit the rim.
 */
function drawRadar(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: HudState<Target>,
  heading: number,
  focusId: string | null,
) {
  const cx = w * RADAR_X;
  const cy = h * RADAR_Y;
  const r = w * RADAR_R;
  const farthest = Math.max(0, ...s.planes.map((p) => p.distanceKm));
  const range = RADAR_RANGES_KM.find((km) => km >= farthest) ?? RADAR_RANGES_KM[RADAR_RANGES_KM.length - 1];
  // Screen angle for a bearing: straight up = where you're looking.
  const toXY = (bearingDeg: number, frac: number) => {
    const a = (signedDiffDeg(bearingDeg, heading) * Math.PI) / 180;
    return [cx + Math.sin(a) * r * frac, cy - Math.cos(a) * r * frac] as const;
  };

  ctx.save();
  // Disc + range ring.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.hudDim;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r / 2, 0, Math.PI * 2);
  ctx.stroke();

  // View cone (what's on the compass bar) and the focus cone inside it.
  const wedge = (halfDeg: number, fill: string) => {
    const a = (halfDeg * Math.PI) / 180;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2 - a, -Math.PI / 2 + a);
    ctx.closePath();
    ctx.fill();
  };
  wedge(halfFovDeg(s.halfTan), 'rgba(79, 195, 247, 0.18)');
  wedge(FOCUS_HALF_DEG, 'rgba(255, 201, 77, 0.22)');

  // Compass: tick marks every 30° around the rim, and N/E/S/W just outside it (N highlighted).
  ctx.strokeStyle = COLORS.hudDim;
  ctx.lineWidth = 1;
  for (let deg = 0; deg < 360; deg += 30) {
    const [x1, y1] = toXY(deg, deg % 90 === 0 ? 0.86 : 0.92);
    const [x2, y2] = toXY(deg, 1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  const labelFrac = 1 + fs(8) / r;
  for (const [deg, name] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']] as const) {
    const [x, y] = toXY(deg, labelFrac);
    label(ctx, x, y, name, fs(deg === 0 ? 11 : 9), deg === 0 ? COLORS.focus : COLORS.text, 'center', true);
  }

  // Planes, far to near so close ones draw on top; the focused one last.
  const blinkOff = Math.floor(s.timeMs / BLINK_MS) % 2 === 1;
  const inRange = s.planes.filter((p) => p.distanceKm <= range).sort((a, b) => b.distanceKm - a.distanceKm);
  const focus = inRange.find((p) => p.id === focusId);
  for (const p of [...inRange.filter((p) => p !== focus), ...(focus ? [focus] : [])]) {
    const status = aircraftStatus(p);
    if (status === 'emergency' && blinkOff) continue;
    const [x, y] = toXY(p.bearingDeg, p.distanceKm / range);
    ctx.fillStyle = p === focus ? COLORS.focus : STATUS_COLORS[status];
    ctx.beginPath();
    ctx.arc(x, y, p === focus ? 3.2 : 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // You.
  ctx.fillStyle = COLORS.text;
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Range below the disc, outside the ring of N/E/S/W labels.
  label(ctx, cx, cy + r + fs(20), `${range} km`, fs(8), 'rgba(255,255,255,0.75)', 'center');
}

function drawPlanes(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState<Target>): HudResult<Target> {
  const barY = h * COMPASS_Y;
  const x0 = (w * (1 - COMPASS_WIDTH)) / 2;
  const x1 = w - x0;

  if (s.headingDeg == null) {
    label(ctx, w / 2, barY, 'Waiting for compass…', fs(14), COLORS.text, 'center', true);
    return NO_PLANES;
  }
  const heading = s.headingDeg;
  const transit = s.selectedFocusId !== undefined;
  if (transit) drawTransitCompass(ctx, w, barY, x0, x1, heading, s.halfTan);
  else drawCompass(ctx, w, barY, x0, x1, heading, s.halfTan);

  const half = halfFovDeg(s.halfTan);
  const withOffset = s.planes.map((p) => ({ p, off: signedDiffDeg(p.bearingDeg, heading) }));
  const onBar = withOffset
    .filter((x) => Math.abs(x.off) <= half)
    .map((x) => ({ ...x, x: projectX(x.off, s.halfTan, w) }))
    .filter((x): x is typeof x & { x: number } => x.x != null && x.x >= x0 && x.x <= x1);

  if (s.planes.length === 0) {
    if (s.selectedFocusId === undefined) focusAnim = null;
    label(ctx, w / 2, labelRowY(barY) + fs(18), s.selectedFocusId !== undefined ? '' : `No planes · ${s.status}`, fs(11), COLORS.text, 'center');
    return NO_PLANES;
  }

  if (onBar.length === 0) {
    if (s.selectedFocusId === undefined) focusAnim = null;
    const nearest = withOffset.sort((a, b) => Math.abs(a.off) - Math.abs(b.off))[0];
    if (nearest) (transit ? drawBusEdgeArrow : drawEdgeArrow)(ctx, barY, x0, x1, nearest.p, nearest.off);
    return NO_PLANES;
  }

  const closest = onBar.reduce((a, b) => (Math.abs(b.off) < Math.abs(a.off) ? b : a));
  const focus = s.selectedFocusId !== undefined ? onBar.find(m => m.p.id === s.selectedFocusId) ?? null : Math.abs(closest.off) <= FOCUS_HALF_DEG ? closest : null;
  // Far to near, so closer aircraft draw on top.
  const byDistance = [...onBar].sort((a, b) => b.p.distanceKm - a.p.distanceKm);
  const inView = onBar.map((m) => ({ ...m.p, offsetDeg: m.off }));
  if (transit) {
    // Minimal by default (route badges); the selected bus adds a glow and a detail card.
    const rows = badgeRows(ctx, onBar, focus?.p.id ?? null);
    for (const m of byDistance) {
      const row = rows.get(m.p.id);
      if (m === focus || row == null || !('route' in m.p)) continue;
      const dwelling = m.p.id === s.dwellId;
      drawBusBadge(ctx, m.x, barY, m.p.route, dwelling ? 'dwell' : 'idle', row, dwelling ? s.dwellProgress ?? 0 : 0);
    }
    if (!focus || !('route' in focus.p)) return { focus: null, inView };
    drawBusBadge(ctx, focus.x, barY, focus.p.route, 'focus', rows.get(focus.p.id) ?? 0, 1);
    const t = Math.min(1, Math.max(0, (s.timeMs - (s.focusSinceMs ?? 0)) / BUS_CARD_ANIM_MS));
    if (!s.expandedMap) drawBusCard(ctx, w, focus.x, barY, focus.p, t);
    return { focus: { ...focus.p, offsetDeg: focus.off }, inView };
  }
  for (const m of byDistance) if (m !== focus) drawAircraft(ctx, m.x, barY, m.p, false, s.timeMs);

  if (!focus) {
    if (s.selectedFocusId === undefined) focusAnim = null;
    return { focus: null, inView };
  }
  if (s.selectedFocusId === undefined && focusAnim?.id !== focus.p.id) focusAnim = { id: focus.p.id, since: s.timeMs };
  const t = s.selectedFocusId !== undefined ? 1 : Math.min(1, (s.timeMs - focusAnim!.since) / CARD_ANIM_MS);
  drawAircraft(ctx, focus.x, barY, focus.p, true, s.timeMs);
  const status = aircraftStatus(focus.p);
  const accent = status === 'normal' ? COLORS.focus : STATUS_COLORS[status];
  if (!s.expandedMap) drawCard(ctx, w, focus.x, barY, cardLines(focus.p), t, accent, statusTag(focus.p));
  return { focus: { ...focus.p, offsetDeg: focus.off }, inView };
}

let voiceStartMs: number | null = null;

/** Voice subtitles: status pill, the question, and the answer, stacked up from VOICE_Y. */
function drawVoice(ctx: CanvasRenderingContext2D, w: number, h: number, v: VoiceHud, timeMs: number) {
  voiceStartMs ??= timeMs;
  const maxW = w * 0.78;
  let bottom = h * VOICE_Y;

  if (v.error) {
    label(ctx, w / 2, bottom, v.error, fs(10), '#ff8a80', 'center');
    bottom -= fs(16);
  }

  if (v.answer) {
    ctx.save();
    ctx.font = `500 ${fs(12)}px ${FONT}`;
    const lines = wrapLines(ctx, v.answer, maxW - 16).slice(0, 4);
    const lineH = fs(12) + 4;
    const panelW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16);
    const panelH = lines.length * lineH + 10;
    const x = (w - panelW) / 2;
    const y = bottom - panelH;
    ctx.fillStyle = COLORS.panel;
    roundRect(ctx, x, y, panelW, panelH, 6);
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 5 + lineH * (i + 0.5)));
    ctx.restore();
    bottom = y - fs(10);
  }

  if (v.transcript && (v.answer || v.state === 'thinking')) {
    ctx.save();
    ctx.font = `italic 500 ${fs(11)}px ${FONT}`;
    const q = wrapLines(ctx, `“${v.transcript}”`, maxW)[0];
    ctx.restore();
    label(ctx, w / 2, bottom, q, fs(11), 'rgba(255,255,255,0.75)', 'center');
    bottom -= fs(18);
  }

  const pulse = 0.5 + 0.5 * Math.sin(timeMs / 180);
  if (v.state === 'listening') pill(ctx, w / 2, bottom, 'Listening…', `rgba(255, 82, 82, ${0.5 + 0.5 * pulse})`);
  else if (v.state === 'thinking') pill(ctx, w / 2, bottom, `Thinking${'.'.repeat(1 + (Math.floor(timeMs / 300) % 3))}`, COLORS.hud);
  else if (v.state === 'speaking') pill(ctx, w / 2, bottom, 'Grok', COLORS.focus);
  else if (!v.answer && !v.error && timeMs - voiceStartMs < HINT_MS) {
    label(ctx, w / 2, bottom, 'Say “Hey Grok…”', fs(10), 'rgba(255,255,255,0.6)', 'center');
  }
}

/** Small rounded status label with a colored dot. */
function pill(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string, dot: string) {
  ctx.save();
  ctx.font = `700 ${fs(11)}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const pw = tw + 26;
  const ph = fs(11) + 8;
  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
  ctx.fill();
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(cx - pw / 2 + 10, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.fillText(text, cx - pw / 2 + 18, cy);
  ctx.restore();
}

/** Greedy word wrap using the context's current font. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCompass(
  ctx: CanvasRenderingContext2D,
  w: number,
  barY: number,
  x0: number,
  x1: number,
  heading: number,
  halfTan: number,
) {
  const half = halfFovDeg(halfTan);
  const labelY = labelRowY(barY);
  const headingBoxHalfW = fs(22);

  ctx.save();
  ctx.strokeStyle = COLORS.hudDim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, barY);
  ctx.lineTo(x1, barY);
  ctx.stroke();

  // Ticks hang below the bar; labels below the ticks.
  const start = Math.ceil((heading - half) / 5) * 5;
  for (let d = start; d <= heading + half; d += 5) {
    const x = projectX(signedDiffDeg(d, heading), halfTan, w);
    if (x == null || x < x0 || x > x1) continue;
    const deg = normalizeDeg(d);
    const major = deg % 30 === 0;
    ctx.strokeStyle = major ? COLORS.hud : COLORS.hudDim;
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, barY);
    ctx.lineTo(x, barY + (major ? 6 : deg % 10 === 0 ? 4 : 2));
    ctx.stroke();
    // Skip labels that would collide with the heading readout in the middle.
    if (major && Math.abs(x - w / 2) > headingBoxHalfW + fs(8)) {
      const name = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[deg] ?? String(deg);
      label(ctx, x, labelY, name, fs(name.length === 1 ? 12 : 10), COLORS.text, 'center', true);
    }
  }

  // Center mark across the bar + heading readout below it.
  ctx.strokeStyle = COLORS.focus;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w / 2, barY - 5);
  ctx.lineTo(w / 2, barY + 7);
  ctx.stroke();
  label(ctx, w / 2, labelY, `${Math.round(normalizeDeg(heading))}°`, fs(12), COLORS.focus, 'center', true);
  ctx.restore();
}

// Icons in a 24x24 box centered on (12, 12).
// Plane: top-down silhouette pointing up (Material "flight" icon).
const PLANE_PATH = new Path2D(
  'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
);
// Helicopter: side view facing right (rotor, cabin, tail boom and fin, skids).
const HELI_PATH = (() => {
  const p = new Path2D();
  p.ellipse(14.5, 12.5, 5, 3.6, 0, 0, Math.PI * 2); // cabin
  p.rect(2.5, 11.2, 9, 1.8); // tail boom
  p.rect(1.5, 8.2, 2, 5.5); // tail fin / rotor
  p.rect(13.7, 6.8, 1.6, 2.6); // mast
  p.rect(4, 5.6, 19, 1.5); // main rotor
  p.rect(11.2, 15.5, 1.2, 3); // skid struts
  p.rect(16.8, 15.5, 1.2, 3);
  p.rect(9, 18, 11.5, 1.4); // skid
  return p;
})();

/**
 * Aircraft marker on the compass bar. Oriented by its direction of travel relative to your line
 * of sight: the plane icon points up when flying away, sideways when crossing your view, down when
 * coming toward you; the helicopter faces left or right. Colored by status (see STATUS_COLORS);
 * the focused aircraft is larger, and yellow if it has no special status (otherwise yellow outline).
 */
/** Icon size shrinks with distance (depth cue, less clutter): 15px up close down to 10px at 40 km. */
const ICON_NEAR_PX = 15;
const ICON_FAR_PX = 10;
const ICON_FAR_KM = 40;

function drawAircraft(ctx: CanvasRenderingContext2D, x: number, y: number, p: Target, focus: boolean, timeMs: number) {
  if ('route' in p) return;
  const status = aircraftStatus(p);
  // Emergencies blink so they're impossible to miss.
  const blinkOff = status === 'emergency' && Math.floor(timeMs / BLINK_MS) % 2 === 1;
  const far = Math.min(1, p.distanceKm / ICON_FAR_KM);
  const size = focus ? 19 : ICON_NEAR_PX - (ICON_NEAR_PX - ICON_FAR_PX) * far;
  const heli = p.kind === 'helicopter';
  // 0 = flying directly away from the viewer, + = moving to the viewer's right.
  const rel = p.trackDeg == null ? 0 : signedDiffDeg(p.trackDeg, p.bearingDeg);
  const s = size / 24;

  ctx.save();
  ctx.translate(x, y);
  if (heli) {
    ctx.scale(rel < 0 ? -s : s, s);
  } else {
    ctx.rotate((rel * Math.PI) / 180);
    ctx.scale(s, s);
  }
  ctx.translate(-12, -12);
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 4;
  ctx.lineJoin = 'round';
  if (blinkOff) ctx.globalAlpha = 0.25;
  const path = heli ? HELI_PATH : PLANE_PATH;
  // Outline: yellow marks the focused aircraft when its fill is a status color.
  const focusOutline = focus && status !== 'normal';
  ctx.lineWidth = (focusOutline ? 3.2 : 2.2) / s;
  ctx.strokeStyle = focusOutline ? COLORS.focus : 'rgba(0, 0, 0, 0.7)';
  ctx.stroke(path);
  ctx.fillStyle = focus && status === 'normal' ? COLORS.focus : STATUS_COLORS[status];
  ctx.fill(path);
  ctx.restore();
}

/** Bus route badges: pill height, rows they may stack into above the bar, gap between rows. */
const BADGE_H = fs(17);
const BADGE_FOCUS_H = fs(21);
const BADGE_ROWS = 3;
const BADGE_ROW_GAP = fs(4);

const badgeFont = (focus: boolean) => `800 ${focus ? fs(15) : fs(12)}px ${FONT}`;

function badgeWidth(ctx: CanvasRenderingContext2D, route: string, focus: boolean): number {
  ctx.save();
  ctx.font = badgeFont(focus);
  const w = ctx.measureText(route).width + (focus ? fs(18) : fs(14));
  ctx.restore();
  return Math.max(w, (focus ? BADGE_FOCUS_H : BADGE_H) * 1.4);
}

/**
 * Assigns each bus badge a row so neighbors don't overlap: the focused bus, then the nearest,
 * get the row closest to the bar. Badges that fit in no row are skipped (they stay on the minimap).
 */
function badgeRows(ctx: CanvasRenderingContext2D, markers: { p: Target; x: number }[], focusId: string | null) {
  const rows = new Map<string, number>();
  const taken: { l: number; r: number }[][] = Array.from({ length: BADGE_ROWS }, () => []);
  const order = [...markers].sort((a, b) =>
    a.p.id === focusId ? -1 : b.p.id === focusId ? 1 : a.p.distanceKm - b.p.distanceKm,
  );
  for (const m of order) {
    if (!('route' in m.p)) continue;
    const half = badgeWidth(ctx, m.p.route, m.p.id === focusId) / 2 + 2;
    const row = taken.findIndex((spans) => spans.every((s) => m.x + half < s.l || m.x - half > s.r));
    if (row < 0) continue;
    taken[row].push({ l: m.x - half, r: m.x + half });
    rows.set(m.p.id, row);
  }
  return rows;
}

type BadgeState = 'idle' | 'dwell' | 'focus';

/**
 * Route-number pill above the bar with a stem down to the bus's exact bearing. While a bus dwells
 * in the focus cone the badge fills with teal; once selected it turns solid teal and glows.
 */
function drawBusBadge(ctx: CanvasRenderingContext2D, x: number, barY: number, route: string, state: BadgeState, row: number, dwellT: number) {
  const focus = state === 'focus';
  const h = focus ? BADGE_FOCUS_H : BADGE_H;
  const w = badgeWidth(ctx, route, focus);
  const bottom = barY - fs(6) - row * (BADGE_H + BADGE_ROW_GAP);
  const top = bottom - h;
  const left = x - w / 2;

  ctx.save();
  ctx.strokeStyle = focus ? T.secondary : T.primaryDim;
  ctx.lineWidth = focus ? 1.5 : 1;
  ctx.beginPath();
  ctx.moveTo(x, bottom);
  ctx.lineTo(x, barY);
  ctx.stroke();
  ctx.fillStyle = focus ? T.secondary : T.primary;
  ctx.beginPath();
  ctx.arc(x, barY, focus ? 3 : 2, 0, Math.PI * 2);
  ctx.fill();

  roundRect(ctx, left, top, w, h, h / 2);
  if (focus) {
    ctx.shadowColor = T.secondaryGlow;
    ctx.shadowBlur = 10;
    ctx.fillStyle = T.secondary;
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.shadowColor = T.shadow;
    ctx.shadowBlur = 4;
    ctx.fillStyle = T.glass;
    ctx.fill();
    ctx.shadowBlur = 0;
    if (state === 'dwell' && dwellT > 0) {
      // Dwell: the badge fills with teal from the left until the card opens.
      ctx.save();
      ctx.clip();
      ctx.fillStyle = 'rgba(140, 231, 219, 0.45)';
      ctx.fillRect(left, top, w * dwellT, h);
      ctx.restore();
      roundRect(ctx, left, top, w, h, h / 2);
    }
    ctx.strokeStyle = state === 'dwell' ? T.secondary : T.primaryDim;
    ctx.lineWidth = state === 'dwell' ? 1.5 : 1;
    ctx.stroke();
  }

  ctx.font = badgeFont(focus);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = focus ? T.onAccent : T.text;
  ctx.fillText(route, x, top + h / 2 + 0.5);
  ctx.restore();
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cardinal = (deg: number) => CARDINALS[Math.round(normalizeDeg(deg) / 45) % 8];

/** Compact headband compass: a bar that fades at the ends, light ticks, and a heading pill. */
function drawTransitCompass(
  ctx: CanvasRenderingContext2D,
  w: number,
  barY: number,
  x0: number,
  x1: number,
  heading: number,
  halfTan: number,
) {
  const half = halfFovDeg(halfTan);
  const labelY = labelRowY(barY);
  const readout = `${Math.round(normalizeDeg(heading))}° ${cardinal(heading)}`;
  ctx.save();
  ctx.font = `700 ${fs(11)}px ${FONT}`;
  const pillW = ctx.measureText(readout).width + fs(16);
  const pillH = fs(11) + 8;

  const bar = ctx.createLinearGradient(x0, 0, x1, 0);
  bar.addColorStop(0, 'rgba(167, 184, 255, 0)');
  bar.addColorStop(0.18, T.primaryDim);
  bar.addColorStop(0.82, T.primaryDim);
  bar.addColorStop(1, 'rgba(167, 184, 255, 0)');
  ctx.strokeStyle = bar;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, barY);
  ctx.lineTo(x1, barY);
  ctx.stroke();

  const mid = w / 2;
  const span = (x1 - x0) / 2;
  const start = Math.ceil((heading - half) / 5) * 5;
  for (let d = start; d <= heading + half; d += 5) {
    const x = projectX(signedDiffDeg(d, heading), halfTan, w);
    if (x == null || x < x0 || x > x1) continue;
    const deg = normalizeDeg(d);
    const major = deg % 30 === 0;
    // Fade toward the lens edges.
    const fade = 1 - Math.pow(Math.abs(x - mid) / span, 3);
    ctx.globalAlpha = Math.max(0, fade);
    ctx.strokeStyle = major ? T.primary : T.primaryFaint;
    ctx.lineWidth = major ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x, barY);
    ctx.lineTo(x, barY + (major ? 6 : deg % 10 === 0 ? 4 : 2.5));
    ctx.stroke();
    if (major && Math.abs(x - mid) > pillW / 2 + fs(10)) {
      const name = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[deg];
      label(ctx, x, labelY, name ?? String(deg), fs(name ? 11 : 9), name ? T.text : T.muted, 'center', !!name);
    }
  }
  ctx.globalAlpha = 1;

  // Center mark and heading pill.
  ctx.strokeStyle = T.secondary;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(mid, barY - 4);
  ctx.lineTo(mid, barY + 5);
  ctx.stroke();
  ctx.shadowColor = T.shadow;
  ctx.shadowBlur = 4;
  roundRect(ctx, mid - pillW / 2, labelY - pillH / 2, pillW, pillH, pillH / 2);
  ctx.fillStyle = T.glass;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = T.glassBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = T.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(readout, mid, labelY + 0.5);
  ctx.restore();
}

/** Truncates with an ellipsis to fit `maxW` in the context's current font. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/**
 * Glass detail card for the selected bus, hanging under the compass: route chip, destination,
 * stats, and the delay tag. `t` is the fade/slide-in progress 0..1.
 */
function drawBusCard(ctx: CanvasRenderingContext2D, w: number, mx: number, barY: number, b: Bus, t: number) {
  const c = busCard(b);
  const tag = statusTag(b);
  const ease = 1 - Math.pow(1 - t, 3);
  const pad = fs(10);
  const gap = fs(9);
  const chipH = fs(24);
  const destSize = fs(14);
  const statsSize = fs(11);
  const tagSize = fs(8.5);
  const tagH = fs(15);
  const maxW = Math.min(w * 0.8, w - 12);

  ctx.save();
  ctx.globalAlpha = ease;
  ctx.font = `800 ${fs(15)}px ${FONT}`;
  const chipW = Math.max(ctx.measureText(c.route).width + fs(16), chipH * 1.25);
  ctx.font = `700 ${destSize}px ${FONT}`;
  const destW = ctx.measureText(c.destination).width;
  ctx.font = `500 ${statsSize}px ${FONT}`;
  const statsW = ctx.measureText(c.stats).width;
  ctx.font = `800 ${tagSize}px ${FONT}`;
  const tagW = tag ? ctx.measureText(tag).width + fs(14) : 0;

  // The tag shares the stats line when it fits, keeping the card short and the center clear.
  const tagGap = fs(8);
  const inline = !!tag && pad * 2 + chipW + gap + statsW + tagGap + tagW <= maxW;
  const textW = Math.max(destW, inline ? statsW + tagGap + tagW : Math.max(statsW, tagW));
  const cardW = Math.min(maxW, pad * 2 + chipW + gap + textW);
  const cardH = pad * 2 + Math.max(chipH, destSize + 5 + Math.max(statsSize, inline ? tagH : 0) + (tag && !inline ? 7 + tagH : 0));
  const x = Math.max(6, Math.min(w - cardW - 6, mx - cardW / 2));
  const y = labelRowY(barY) + fs(14) - (1 - ease) * 6;
  const r = fs(14);

  // Panel
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  roundRect(ctx, x, y, cardW, cardH, r);
  ctx.fillStyle = T.glass;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = T.glassBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Teal hairline along the top edge ties the card to the selected badge.
  const hl = ctx.createLinearGradient(x, 0, x + cardW, 0);
  hl.addColorStop(0, 'rgba(140, 231, 219, 0)');
  hl.addColorStop(0.5, T.secondary);
  hl.addColorStop(1, 'rgba(140, 231, 219, 0)');
  ctx.strokeStyle = hl;
  ctx.beginPath();
  ctx.moveTo(x + r, y + 0.5);
  ctx.lineTo(x + cardW - r, y + 0.5);
  ctx.stroke();

  // Route chip
  const cx = x + pad;
  const cy = y + pad;
  roundRect(ctx, cx, cy, chipW, chipH, fs(8));
  ctx.fillStyle = T.secondary;
  ctx.fill();
  ctx.font = `800 ${fs(15)}px ${FONT}`;
  ctx.fillStyle = T.onAccent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(c.route, cx + chipW / 2, cy + chipH / 2 + 0.5);

  // Text column
  const tx = cx + chipW + gap;
  const avail = x + cardW - pad - tx;
  ctx.textAlign = 'left';
  let ty = cy + destSize / 2;
  ctx.font = `700 ${destSize}px ${FONT}`;
  ctx.fillStyle = T.text;
  ctx.fillText(ellipsize(ctx, c.destination, avail), tx, ty);
  ty += destSize / 2 + 5 + statsSize / 2;
  ctx.font = `500 ${statsSize}px ${FONT}`;
  ctx.fillStyle = T.muted;
  ctx.fillText(ellipsize(ctx, c.stats, inline ? statsW : avail), tx, ty);

  if (tag) {
    const delayed = b.delayed === true;
    const color = delayed ? T.warning : T.secondary;
    const tagX = inline ? tx + statsW + tagGap : tx;
    const ty2 = inline ? ty - tagH / 2 : ty + statsSize / 2 + 7;
    roundRect(ctx, tagX, ty2, Math.min(tagW, avail), tagH, tagH / 2);
    ctx.fillStyle = delayed ? 'rgba(255, 207, 122, 0.16)' : 'rgba(140, 231, 219, 0.12)';
    ctx.fill();
    ctx.strokeStyle = delayed ? 'rgba(255, 207, 122, 0.6)' : 'rgba(140, 231, 219, 0.45)';
    ctx.stroke();
    ctx.font = `800 ${tagSize}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(ellipsize(ctx, tag, avail - fs(14)), tagX + fs(7), ty2 + tagH / 2 + 0.5);
  }
  ctx.restore();
}

/** Nothing on the bar: a chevron at the bar's end toward the bus with the smallest turn. */
function drawBusEdgeArrow(ctx: CanvasRenderingContext2D, barY: number, x0: number, x1: number, p: Target, off: number) {
  const left = off < 0;
  const dir = left ? -1 : 1;
  const tip = left ? x0 - 2 : x1 + 2;
  ctx.save();
  ctx.strokeStyle = T.secondary;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = T.shadow;
  ctx.shadowBlur = 4;
  for (const step of [0, 6]) {
    const tx = tip - dir * step;
    ctx.globalAlpha = step ? 0.5 : 1;
    ctx.beginPath();
    ctx.moveTo(tx - dir * 5, barY - 6);
    ctx.lineTo(tx, barY);
    ctx.lineTo(tx - dir * 5, barY + 6);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  const text = `${'route' in p ? `Route ${p.route}` : flightLabel(p)} · ${Math.round(Math.abs(off))}°`;
  ctx.font = `700 ${fs(10)}px ${FONT}`;
  const pw = ctx.measureText(text).width + fs(16);
  const ph = fs(10) + 8;
  const px = left ? x0 : x1 - pw;
  const py = labelRowY(barY) + fs(6);
  roundRect(ctx, px, py, pw, ph, ph / 2);
  ctx.fillStyle = T.glass;
  ctx.fill();
  ctx.strokeStyle = T.glassBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = T.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, px + pw / 2, py + ph / 2 + 0.5);
  ctx.restore();
}

/** Feed/sensor status as one compact pill near the bottom; warnings get an amber dot. */
function drawStatus(ctx: CanvasRenderingContext2D, w: number, h: number, status: string) {
  const lines = wrapStatus(status);
  if (!lines.length) return;
  const warn = /unavailable|denied|waiting|pending|accuracy/i.test(status);
  const size = fs(9.5);
  const lineH = size + 4;
  ctx.save();
  ctx.font = `600 ${size}px ${FONT}`;
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const dot = fs(10);
  const pw = Math.min(w * 0.84, tw + fs(20) + dot);
  const ph = lines.length * lineH + 7;
  const x = (w - pw) / 2;
  const y = h * STATUS_Y - ph / 2;
  roundRect(ctx, x, y, pw, ph, Math.min(ph / 2, fs(10)));
  ctx.fillStyle = T.glass;
  ctx.fill();
  ctx.strokeStyle = T.glassBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = warn ? T.warning : T.secondary;
  ctx.beginPath();
  ctx.arc(x + fs(10), y + ph / 2, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = T.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, x + fs(10) + dot - 2, y + 3.5 + lineH * (i + 0.5), pw - dot - fs(16)));
  ctx.restore();
}

/** Vertical center of the status pill (fraction of eye height): between the map and the attribution. */
const STATUS_Y = 0.885;

/** Row below the bar holding the degree labels and heading readout. */
const labelRowY = (barY: number) => barY + fs(18);

/**
 * Info card attached right under the compass, dropping down from it. `t` is animation progress 0..1.
 * `accent` colors the side bar and notch; `tag` (e.g. "MEDICAL") is an optional line above the title.
 */
function drawCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  mx: number,
  barY: number,
  lines: string[],
  t: number,
  accent: string,
  tag: string | null,
) {
  const pad = 6;
  const titleSize = fs(15);
  const bodySize = fs(13);
  const tagSize = fs(10);
  const lineGap = 3;
  const tagH = tag ? tagSize + lineGap : 0;
  const ease = 1 - (1 - t) * (1 - t);

  ctx.save();
  ctx.globalAlpha = ease;
  const widths = lines.map((l, i) => {
    ctx.font = `${i === 0 ? 700 : 500} ${i === 0 ? titleSize : bodySize}px ${FONT}`;
    return ctx.measureText(l).width;
  });
  if (tag) {
    ctx.font = `800 ${tagSize}px ${FONT}`;
    widths.push(ctx.measureText(tag).width);
  }
  const cardW = Math.min(w - 12, Math.max(...widths) + pad * 2 + 4);
  const cardH = pad * 2 + tagH + titleSize + (lines.length - 1) * (bodySize + lineGap);
  const x = Math.max(6, Math.min(w - cardW - 6, mx - cardW / 2));
  const y = labelRowY(barY) + fs(10) - (1 - ease) * 8;

  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, x, y, cardW, cardH, 6);
  ctx.fill();
  // Notch on the card's top edge pointing up at the aircraft icon.
  const nx = Math.max(x + 8, Math.min(x + cardW - 8, mx));
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(nx, y - 5);
  ctx.lineTo(nx - 5, y);
  ctx.lineTo(nx + 5, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(x, y + 5, 3, cardH - 10);

  if (tag) {
    ctx.font = `800 ${tagSize}px ${FONT}`;
    ctx.fillStyle = accent;
    ctx.textAlign = 'left';
    ctx.fillText(tag, x + pad + 4, y + pad + tagSize / 2, cardW - pad * 2 - 4);
  }
  let ty = y + pad + tagH + titleSize / 2;
  lines.forEach((l, i) => {
    const size = i === 0 ? titleSize : bodySize;
    if (i > 0) ty += (i === 1 ? titleSize / 2 : bodySize / 2) + lineGap + size / 2;
    ctx.font = `${i === 0 ? 700 : 500} ${size}px ${FONT}`;
    ctx.fillStyle = i === 0 ? COLORS.text : 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(l, x + pad + 4, ty, cardW - pad * 2 - 4);
  });
  ctx.restore();
}

/** When nothing is on the bar: arrow at the bar's end toward the plane with the smallest turn. */
function drawEdgeArrow(ctx: CanvasRenderingContext2D, barY: number, x0: number, x1: number, p: Target, off: number) {
  const left = off < 0;
  const tip = left ? x0 - 4 : x1 + 4;
  const back = left ? tip + 9 : tip - 9;
  ctx.save();
  ctx.fillStyle = COLORS.focus;
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.moveTo(tip, barY);
  ctx.lineTo(back, barY - 6);
  ctx.lineTo(back, barY + 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const text = `${flightLabel(p)} · ${Math.round(Math.abs(off))}°`;
  label(ctx, left ? x0 + 2 : x1 - 2, labelRowY(barY) + fs(16), text, fs(12), COLORS.text, left ? 'left' : 'right', true);
}

function label(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  size: number,
  color: string,
  align: CanvasTextAlign,
  bold = false,
) {
  ctx.save();
  ctx.font = `${bold ? 700 : 600} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 3;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Keep operational status readable without covering the map or the center. */
function wrapStatus(status: string): string[] {
  const parts = status.split(' · ');
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    if (line && line.length + part.length > 55) { lines.push(line); line = ''; }
    line += (line ? ' · ' : '') + part;
  }
  if (line) lines.push(line);
  return lines;
}

/** Floating minimap: circular (compact) or rounded square (expanded), glass rim, range chip. */
function drawStreetMap(ctx: CanvasRenderingContext2D, w: number, h: number, f: MapFrame) {
  const expanded = f.mode === 'expanded';
  const size = expanded ? Math.min(w * 0.82, h * 0.46) : Math.min(w * 0.39, h * 0.33);
  const x = expanded ? (w - size) / 2 : w * 0.27 - size / 2;
  const y = h * 0.82 - size;
  const cx = x + size / 2;
  const shape = () => {
    if (expanded) roundRect(ctx, x, y, size, size, fs(16));
    else {
      ctx.beginPath();
      ctx.arc(cx, y + size / 2, size / 2, 0, Math.PI * 2);
    }
  };

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 16;
  shape();
  ctx.fillStyle = T.glass;
  ctx.fill();
  ctx.restore();

  ctx.save();
  shape();
  ctx.clip();
  ctx.globalAlpha = expanded ? 0.82 : 0.95;
  if (f.located) ctx.drawImage(f.canvas, x, y, size, size);
  ctx.restore();

  ctx.save();
  shape();
  ctx.strokeStyle = T.primaryDim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Heading-up marker at the top of the rim (or N when the compass is unavailable).
  if (f.located) {
    if (f.northUp) label(ctx, cx, y + fs(9), 'N', fs(9), T.text, 'center', true);
    else {
      ctx.fillStyle = T.secondary;
      ctx.beginPath();
      ctx.moveTo(cx, y + 7);
      ctx.lineTo(cx - 4, y - 1);
      ctx.lineTo(cx + 4, y - 1);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Range chip straddling the bottom of the rim.
  const caption = !f.located ? 'Waiting for location' : `${f.extentKm.toFixed(f.extentKm < 1 ? 2 : 1)} km${f.northUp ? ' · N up · no compass' : ''}`;
  ctx.font = `700 ${fs(8.5)}px ${FONT}`;
  const cw = ctx.measureText(caption).width + fs(12);
  const ch = fs(8.5) + 6;
  const capY = y + size - ch / 2;
  roundRect(ctx, cx - cw / 2, capY, cw, ch, ch / 2);
  ctx.fillStyle = T.glass;
  ctx.fill();
  ctx.strokeStyle = T.glassBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = T.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(caption, cx, capY + ch / 2 + 0.5);
  if (f.status && f.located) {
    // Fallback notice near the top of the map, clear of the markers around the center.
    ctx.font = `600 ${fs(8)}px ${FONT}`;
    const nw = ctx.measureText(f.status).width + fs(12);
    const nh = fs(8) + 6;
    const ny = y + size * (expanded ? 0.06 : 0.16);
    roundRect(ctx, cx - nw / 2, ny, nw, nh, nh / 2);
    ctx.fillStyle = T.glass;
    ctx.fill();
    ctx.fillStyle = T.warning;
    ctx.fillText(f.status, cx, ny + nh / 2 + 0.5);
  }

  ctx.fillStyle = 'rgba(11, 16, 32, 0.85)';
  ctx.fillRect(w * 0.08, h * 0.96 - 7, w * 0.84, 14);
  ctx.fillStyle = T.muted;
  ctx.font = `8px ${FONT}`;
  ctx.fillText('OpenFreeMap © OpenMapTiles © OpenStreetMap', w / 2, h * 0.96);
  ctx.restore();
}
