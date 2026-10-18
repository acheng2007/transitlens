import { signedDiffDeg, toRad } from './geo';

/**
 * Full-screen map panel with visionOS-style lazy follow.
 * The panel is anchored to a world direction; small head movements leave it in place,
 * larger ones let it glide back to the center of view.
 * Computed once per frame and shared by both eyes and casting.
 */
export const PANEL_OPEN_MS = 350;
export const PANEL_CLOSE_MS = 220;
export const YAW_DEADZONE_DEG = 10;
export const PITCH_DEADZONE_DEG = 8;
export const SETTLE_DEG = 2;
/** Critically damped follow time constant. */
export const FOLLOW_TAU_MS = 250;
/** Scale and rise the panel starts from while opening. */
const OPEN_SCALE = 0.92;
const OPEN_RISE = 0.04;

type Axis = { anchor: number | null; velocity: number; following: boolean };
export type MapPanel = { level: number; lastMs: number | null; yaw: Axis; pitch: Axis };
export type MapPanelFrame = { visible: boolean; openT: number; yawOffsetDeg: number; pitchOffsetDeg: number };
export type MapPanelInput = { mode: 'compact' | 'expanded'; headingDeg: number | null; pitchDeg: number | null; timeMs: number; reducedMotion?: boolean };

export const CLOSED_PANEL: MapPanelFrame = { visible: false, openT: 0, yawOffsetDeg: 0, pitchOffsetDeg: 0 };

export function createMapPanel(): MapPanel {
  return { level: 0, lastMs: null, yaw: axis(), pitch: axis() };
}

function axis(): Axis { return { anchor: null, velocity: 0, following: false }; }

/** visionOS-like ease-out; one curve for both directions so reversing never jumps. */
export function easeOut(t: number): number { return 1 - (1 - t) ** 3; }

/** Step one axis: `offset` is the anchor relative to the head, driven toward zero once outside the deadzone. */
function follow(a: Axis, head: number | null, deadzone: number, dtMs: number, wrap: boolean): number {
  if (head === null) { a.anchor = null; a.velocity = 0; a.following = false; return 0; }
  if (a.anchor === null) { a.anchor = head; a.velocity = 0; a.following = false; return 0; }
  const diff = (target: number, from: number) => wrap ? signedDiffDeg(target, from) : target - from;
  let x = diff(a.anchor, head);
  if (!a.following && Math.abs(x) > deadzone) a.following = true;
  if (a.following && dtMs > 0) {
    // Exact critically damped spring step toward the current head direction.
    const w = 1 / FOLLOW_TAU_MS, t = dtMs, e = Math.exp(-w * t);
    const v = a.velocity, k = v + w * x;
    x = (x + k * t) * e;
    a.velocity = (v - w * k * t) * e;
    if (Math.abs(x) < SETTLE_DEG && Math.abs(a.velocity) * 100 < SETTLE_DEG) { a.following = false; a.velocity = 0; }
    a.anchor = head + x;
  }
  return x;
}

export function updateMapPanel(panel: MapPanel, input: MapPanelInput): MapPanelFrame {
  const dt = panel.lastMs === null ? 0 : Math.max(0, input.timeMs - panel.lastMs);
  panel.lastMs = input.timeMs;
  const opening = input.mode === 'expanded';
  if (!opening && panel.level === 0) {
    panel.yaw = axis(); panel.pitch = axis();
    return CLOSED_PANEL;
  }
  if (input.reducedMotion) panel.level = opening ? 1 : 0;
  else panel.level = Math.max(0, Math.min(1, panel.level + (opening ? dt / PANEL_OPEN_MS : -dt / PANEL_CLOSE_MS)));
  const yawOffsetDeg = follow(panel.yaw, input.headingDeg, YAW_DEADZONE_DEG, Math.min(dt, 100), true);
  // Without a heading the panel is head-locked on both axes.
  const pitchOffsetDeg = follow(panel.pitch, input.headingDeg === null ? null : input.pitchDeg ?? 0, PITCH_DEADZONE_DEG, Math.min(dt, 100), false);
  if (!opening && panel.level === 0) { panel.yaw = axis(); panel.pitch = axis(); return CLOSED_PANEL; }
  return { visible: true, openT: easeOut(panel.level), yawOffsetDeg, pitchOffsetDeg };
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Glass bounds at rest: nearly the full view, inset from lens edges (Cardboard) or the screen edges (phone). */
export type SafeInsets = { top: number; right: number; bottom: number; left: number };

export function glassBounds(w: number, h: number, handheld: boolean, safe?: SafeInsets): Rect {
  const mx = handheld ? Math.max(10, w * 0.03) : w * 0.04;
  const top = handheld ? Math.max(h * 0.10, 64) : h * 0.05;
  const bottom = handheld ? Math.max(h * 0.03, 12) : h * 0.05;
  const left = handheld ? Math.max(mx, (safe?.left ?? 0) + 10) : mx;
  const right = handheld ? Math.max(mx, (safe?.right ?? 0) + 10) : mx;
  const insetTop = handheld ? Math.max(top, (safe?.top ?? 0) + 10) : top;
  const insetBottom = handheld ? Math.max(bottom, (safe?.bottom ?? 0) + 10) : bottom;
  return { x: left, y: insetTop, w: Math.max(0, w - left - right), h: Math.max(0, h - insetTop - insetBottom) };
}

/** Where the panel appears this frame: angular offset through the pinhole projection, plus the open animation. */
export function mapPanelRect(w: number, h: number, halfTan: number, frame: MapPanelFrame, rest: Rect): Rect {
  const vHalfTan = halfTan * h / w;
  const clampTan = (deg: number) => Math.tan(toRad(Math.max(-80, Math.min(80, deg))));
  const dx = clampTan(frame.yawOffsetDeg) / halfTan * (w / 2);
  const dy = -clampTan(frame.pitchOffsetDeg) / vHalfTan * (h / 2);
  const scale = OPEN_SCALE + (1 - OPEN_SCALE) * frame.openT;
  const rise = (1 - frame.openT) * OPEN_RISE * h;
  const pw = rest.w * scale, ph = rest.h * scale;
  return { x: rest.x + (rest.w - pw) / 2 + dx, y: rest.y + (rest.h - ph) / 2 + dy + rise, w: pw, h: ph };
}
