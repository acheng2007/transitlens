// Shared transit HUD: route-first bus markers, compass, minimap and voice subtitles.

import { cardLines, statusTag } from './format';
import { bearingDeg, haversineKm, halfFovDeg, normalizeDeg, projectX, signedDiffDeg } from './geo';
import type { MapFrame } from './street-map';
import type { Bus, Position } from './buses';
import type { JourneyState } from './journey-state';
import { arrivalLabel } from './journey-state';
import type { VoiceState } from './voice';

/** What the voice subtitles show. Timing (when to clear the answer) is handled by main.ts. */
export type VoiceHud = {
  state: VoiceState;
  transcript: string | null;
  answer: string | null;
  error: string | null;
  wakeEnabled?: boolean;
};

/** Buses the viewer is looking at this frame (offsetDeg filled in), for voice context. */
export type HudResult<T = Bus> = {
  focus: T | null;
  inView: T[];
};

const NO_BUSES: HudResult<never> = { focus: null, inView: [] };

export type HudState<T = Bus> = {
  headingDeg: number | null;
  /** tan(half horizontal FOV) of what one eye shows. */
  halfTan: number;
  buses: T[];
  /** Shared bus selection, computed once before either eye or casting draws. */
  selectedFocusId?: string | null;
  mapFrame?: MapFrame | null;
  expandedMap?: boolean;
  journey?: JourneyState;
  position?: Position | null;
  assistantSource?: string;
  demo?: boolean;
  handheld?: boolean;
  /** Data feed status, shown when there are no buses at all (e.g. "live · waiting for GPS"). */
  status: string;
  /** Frame timestamp (same for both eyes) for animations. */
  timeMs: number;
  /** null = voice disabled. */
  voice: VoiceHud | null;
};

const COLORS = {
  hud: 'rgba(79, 195, 247, 0.95)',
  hudDim: 'rgba(79, 195, 247, 0.55)',
  focus: '#ffc94d',
  text: '#ffffff',
  panel: 'rgba(0, 0, 0, 0.62)',
  shadow: 'rgba(0, 0, 0, 0.8)',
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Global text size multiplier; tune here if text is too big/small in the headset. */
let textScale = 0.8;
const fs = (px: number) => Math.round(px * textScale * 10) / 10;

/** Vertical position of the compass bar (fraction of eye height). The lenses hide the very top. */
const COMPASS_Y = 0.24;
/** Compass bar spans this fraction of the eye width, centered (the lenses hide the edges). */
const COMPASS_WIDTH = 0.7;
/** A bus gets the info card only when it's within this angle of center (15° total cone). */
export const FOCUS_HALF_DEG = 7.5;

// Tracks when the current focus bus became focused, for the pop-up animation.

/** Subtitle area for voice: bottom edge of the answer panel (fraction of eye height). */
const VOICE_Y = 0.74;
/** How long the idle "Say Hey Gemini" hint stays after start (ms). */
const HINT_MS = 15000;
export function drawHud(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState<Bus>): HudResult<Bus> {
  textScale = s.handheld ? Math.max(1, Math.min(1.4, w / 900)) : 0.8;
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  const result = drawBuses(ctx, w, h, s);
  // Transit map frames remain independent of compass filtering and voice status.
  if (s.mapFrame) drawStreetMap(ctx, w, h, s.mapFrame, !!s.journey?.plan || !!s.journey?.guidance || !!s.voice && (s.voice.state !== 'idle' || !!s.voice.answer || !!s.voice.error));
  else if (s.headingDeg != null) {
    drawRadar(ctx, w, h, s, s.headingDeg, result.focus?.id ?? null);
  }
  if (s.selectedFocusId !== undefined) {
    const words = wrapStatus(s.status);
    words.forEach((line, i) => label(ctx, w / 2, h * 0.88 + i * fs(14), line, fs(10), COLORS.text, 'center'));
  }
  if (s.journey) drawJourney(ctx, w, h, s);
  if (s.voice) drawVoice(ctx, w, h, s.voice, s.timeMs);
  return result;
}

/** The trip result is shared across every eye and casting. */
function drawJourney(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState<Bus>) {
  const state = s.journey!;
  const cx = w * 0.71;
  if (state.guidance) {
    const j = state.guidance;
    label(ctx,cx,h*0.38,`BOARD ROUTE ${j.routeId}`,fs(15),'#b5ff67','center',true);
    ctx.font=`${fs(11)}px ${FONT}`;
    const names=wrapLines(ctx,j.boardingStop.name,w*0.39).slice(0,2);
    names.forEach((line,i)=>label(ctx,cx,h*0.41+i*fs(14),line,fs(11),COLORS.text,'center'));
    label(ctx,cx,h*0.48,arrivalLabel(j),fs(11),'#ffc94d','center');
    if (s.position) {
      const distance=haversineKm(s.position.lat,s.position.lon,j.boardingStop.lat,j.boardingStop.lon);
      const bearing=bearingDeg(s.position.lat,s.position.lon,j.boardingStop.lat,j.boardingStop.lon);
      const off=s.headingDeg===null?null:signedDiffDeg(bearing,s.headingDeg);
      const direction=off===null ? `${Math.round(bearing)}° true` : Math.abs(off)<8?'AHEAD':off<0?'TURN LEFT':'TURN RIGHT';
      label(ctx,cx,h*0.52,`${Math.round(distance*1000)} m · ${direction}`,fs(14),'#b5ff67','center',true);
      label(ctx,cx,h*0.55,'STOP BEARING · NOT A WALKING PATH',fs(7),COLORS.text,'center');
      // Bearing diamond is constrained to the compass, leaving the central view clear.
      if (off!==null) {
        const x=Math.max(w*0.12,Math.min(w*0.88,projectX(off,s.halfTan,w)??(off<0?0:w)));
        const y=h*0.18;
        ctx.save();ctx.translate(x,y);ctx.rotate(Math.PI/4);ctx.fillStyle='#b5ff67';
        ctx.shadowColor='#b5ff67';ctx.shadowBlur=12;ctx.fillRect(-5,-5,10,10);ctx.restore();
        label(ctx,x,y-fs(15),'BOARD',fs(8),'#b5ff67','center',true);
      }
    }
  } else if (state.plan) {
    const p=state.plan;
    label(ctx,cx,h*0.38,p.status==='ambiguous'?'WHICH DESTINATION?':p.options.length?`${p.options.length} DIRECT OPTIONS`:'NO DIRECT TRIP',fs(12),'#b5ff67','center',true);
    p.options.slice(0,3).forEach((j,i)=>{
      label(ctx,cx,h*(0.43+i*0.045),`${i+1} · ROUTE ${j.routeId} · ${j.rideStops} stops`,fs(11),j.color,'center',true);
    });
    if (p.options.length) label(ctx,cx,h*0.57,'Say “take the first option”',fs(9),COLORS.text,'center');
    if (p.status==='ambiguous') label(ctx,cx,h*0.44,'Name a stop to narrow the search',fs(9),COLORS.text,'center');
  }
  if (s.assistantSource) label(ctx,w/2,h*0.12,s.assistantSource.toUpperCase(),fs(8),s.demo?'#ffc94d':'#81d9ed','center');
}

/** Radar center (fractions of eye width/height) and radius (fraction of eye width). Kept inward: lens edges blur. */
const RADAR_X = 0.26;
const RADAR_Y = 0.7;
const RADAR_R = 0.1;
/** Radar range snaps to the smallest of these that fits the farthest bus (km). */
const RADAR_RANGES_KM = [0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 40, 60, 80, 120];

/**
 * Heading-up radar: you're at the center, your view cone points up, buses are dots at their true
 * direction and distance (colored by status, focused bus yellow), and N/E/S/W orbit the rim.
 */
function drawRadar(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: HudState<Bus>,
  heading: number,
  focusId: string | null,
) {
  const cx = w * RADAR_X;
  const cy = h * RADAR_Y;
  const r = w * RADAR_R;
  const farthest = Math.max(0, ...s.buses.map((p) => p.distanceKm));
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

  // Buses, far to near so close ones draw on top; the focused one last.
  const inRange = s.buses.filter((p) => p.distanceKm <= range).sort((a, b) => b.distanceKm - a.distanceKm);
  const focus = inRange.find((p) => p.id === focusId);
  for (const p of [...inRange.filter((p) => p !== focus), ...(focus ? [focus] : [])]) {
    const [x, y] = toXY(p.bearingDeg, p.distanceKm / range);
    ctx.fillStyle = p === focus ? COLORS.focus : (p.delayed === true ? '#ffb74d' : COLORS.hud);
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

function drawBuses(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState<Bus>): HudResult<Bus> {
  const barY = h * COMPASS_Y;
  const x0 = (w * (1 - COMPASS_WIDTH)) / 2;
  const x1 = w - x0;

  if (s.headingDeg == null) {
    label(ctx, w / 2, barY, 'Waiting for compass…', fs(14), COLORS.text, 'center', true);
    return NO_BUSES;
  }
  const heading = s.headingDeg;
  drawCompass(ctx, w, barY, x0, x1, heading, s.halfTan);

  const half = halfFovDeg(s.halfTan);
  const withOffset = s.buses.map((p) => ({ p, off: signedDiffDeg(p.bearingDeg, heading) }));
  const onBar = withOffset
    .filter((x) => Math.abs(x.off) <= half)
    .map((x) => ({ ...x, x: projectX(x.off, s.halfTan, w) }))
    .filter((x): x is typeof x & { x: number } => x.x != null && x.x >= x0 && x.x <= x1);

  if (s.buses.length === 0) {
    return NO_BUSES;
  }

  if (onBar.length === 0) {
    const nearest = withOffset.sort((a, b) => Math.abs(a.off) - Math.abs(b.off))[0];
    if (nearest) drawEdgeArrow(ctx, barY, x0, x1, nearest.p, nearest.off);
    return NO_BUSES;
  }

  const focus = onBar.find(m => m.p.id === s.selectedFocusId) ?? null;
  // Far to near, so closer buses draw on top.
  const byDistance = [...onBar].sort((a, b) => b.p.distanceKm - a.p.distanceKm);
  for (const m of byDistance) if (m !== focus) drawBusMarker(ctx, m.x, barY, m.p, false, s.timeMs);
  const inView = onBar.map((m) => ({ ...m.p, offsetDeg: m.off }));

  if (!focus) {
    return { focus: null, inView };
  }
  const t = 1;
  drawBusMarker(ctx, focus.x, barY, focus.p, true, s.timeMs);
  const accent = COLORS.focus;
  if (!s.expandedMap) drawCard(ctx, w, focus.x, barY, cardLines(focus.p), t, accent, statusTag(focus.p));
  return { focus: { ...focus.p, offsetDeg: focus.off }, inView };
}

let voiceStartMs: number | null = null;

/** Voice subtitles: status pill, the question, and the answer, stacked up from VOICE_Y. */
function drawVoice(ctx: CanvasRenderingContext2D, w: number, h: number, v: VoiceHud, timeMs: number) {
  voiceStartMs ??= timeMs;
  const maxW = w * 0.40;
  const cx = w * 0.71;
  let bottom = h * VOICE_Y;

  if (v.error) {
    ctx.font = `${fs(10)}px ${FONT}`;
    const errors = wrapLines(ctx, v.error, maxW).slice(0, 2);
    errors.forEach(line => { label(ctx, cx, bottom, line, fs(10), '#ff8a80', 'center'); bottom -= fs(14); });
  }

  if (v.answer) {
    ctx.save();
    ctx.font = `500 ${fs(12)}px ${FONT}`;
    const lines = wrapLines(ctx, v.answer, maxW - 16).slice(0, 4);
    const lineH = fs(12) + 4;
    const panelW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16);
    const panelH = lines.length * lineH + 10;
    const x = cx - panelW / 2;
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
    label(ctx, cx, bottom, q, fs(11), 'rgba(255,255,255,0.75)', 'center');
    bottom -= fs(18);
  }

  const pulse = 0.5 + 0.5 * Math.sin(timeMs / 180);
  if (v.state === 'listening') pill(ctx, cx, bottom, 'Listening…', `rgba(255, 82, 82, ${0.5 + 0.5 * pulse})`);
  else if (v.state === 'thinking') pill(ctx, cx, bottom, `Thinking${'.'.repeat(1 + (Math.floor(timeMs / 300) % 3))}`, COLORS.hud);
  else if (v.state === 'speaking') pill(ctx, cx, bottom, 'Gemini', COLORS.focus);
  else if (!v.answer && !v.error && timeMs - voiceStartMs < HINT_MS) {
    label(ctx, cx, bottom, v.wakeEnabled === false ? 'Tap Ask Gemini to type' : 'Say “Hey Gemini…”', fs(10), 'rgba(255,255,255,0.6)', 'center');
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

function drawBusMarker(ctx: CanvasRenderingContext2D, x: number, y: number, p: Bus, focus: boolean, _timeMs: number) {
    const size = focus ? fs(17) : fs(14);
    label(ctx, x, y - fs(13), `🚌 ${p.route}`, size, focus ? COLORS.focus : COLORS.hud, 'center', true);
    return;
}

/** Row below the bar holding the degree labels and heading readout. */
const labelRowY = (barY: number) => barY + fs(18);

/**
 * Info card attached right under the compass, dropping down from it. `t` is animation progress 0..1.
 * `accent` colors the side bar and notch; `tag` (e.g. "DELAYED") is an optional line above the title.
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
  // Notch on the card's top edge pointing up at the buses icon.
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

/** When nothing is on the bar: arrow at the bar's end toward the bus with the smallest turn. */
function drawEdgeArrow(ctx: CanvasRenderingContext2D, barY: number, x0: number, x1: number, p: Bus, off: number) {
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
  const text = `${`Route ${p.route}`} · ${Math.round(Math.abs(off))}°`;
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

function drawStreetMap(ctx: CanvasRenderingContext2D, w: number, h: number, f: MapFrame, withVoice = false) {
  const expanded = f.mode === 'expanded';
  const size = expanded ? Math.min(w * (withVoice ? 0.42 : 0.82), h * 0.46) : Math.min(w * 0.39, h * 0.33);
  const x = expanded && !withVoice ? (w - size) / 2 : w * 0.27 - size / 2;
  const y = h * 0.82 - size;
  ctx.save(); ctx.beginPath();
  if (expanded) ctx.rect(x, y, size, size);
  else ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip(); ctx.globalAlpha = expanded ? 0.76 : 0.94;
  if (f.located) ctx.drawImage(f.canvas, x, y, size, size);
  ctx.restore(); ctx.save();
  ctx.textAlign = 'center'; ctx.font = '9px system-ui'; ctx.fillStyle = '#fff';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
  ctx.fillText(!f.located ? 'Waiting for location' : `${f.extentKm.toFixed(f.extentKm < 1 ? 2 : 1)} km radius${f.northUp ? ' · N up · compass unavailable' : ' · heading up'}`, w / 2, h * 0.84);
  if (f.status && f.located) ctx.fillText(f.status, w / 2, h * 0.35);
  ctx.fillStyle = '#101a22'; ctx.fillRect(w * 0.08, h * 0.96 - 7, w * 0.84, 14);
  ctx.fillStyle = '#eee'; ctx.font = '8px system-ui';
  ctx.fillText('OpenFreeMap © OpenMapTiles © OpenStreetMap', w / 2, h * 0.96);
  ctx.restore();
}
