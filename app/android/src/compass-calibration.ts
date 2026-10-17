// Compass calibration screen (Settings → Calibrate compass).
//
// Android calibrates the magnetometer on its own while the sensor runs and the phone is turned
// through many orientations. This screen keeps the sensor running (native CompassPlugin.java),
// shows the figure-8 motion, and measures the result itself:
//   - coverage (the ring): which directions the magnetic field has been seen from, in the phone's
//     own axes. Turning the phone sweeps the (fixed) Earth field across them.
//   - consistency: a calibrated compass reads the same field strength whichever way the phone
//     points. Each direction keeps a running average of the strength seen there; the spread between
//     directions (± half the max-min gap, as % of the median) is the calibration error. It works the
//     same on every phone, unlike Android's own 4-level rating, which is shown as a secondary hint.
//   - interference: readings far from the strength Earth's field model expects at the user's position
//     (compass.ts) are ignored and trigger a warning.

import type { PluginListenerHandle } from '@capacitor/core';
import { Compass, fieldModel } from './compass';
import type { CompassReading } from './compass';
import { isNative } from './native';

/** Field directions tracked for coverage: the 6 faces and 8 corners of a cube around the phone. */
const DIRECTIONS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ...[-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z] as [number, number, number]))),
].map(([x, y, z]) => {
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
});
/**
 * A direction counts once the field comes within 27° of it (cos 27° = 0.891). That's under half the
 * 54.7° between neighbouring directions, so one steady reading can never count two. (Nearest-direction
 * binning let sensor noise at a border count both while the phone sat still, seen on a Galaxy S22+.)
 */
const COVERED_DOT = 0.891;
/** Covered directions needed (some orientations, like screen facing the ground, are awkward to hold). */
const COVERAGE_GOAL = 10;

/** Readings a direction needs before its average strength counts toward consistency. */
const MIN_SAMPLES = 3;
/** Directions with enough samples needed to show consistency at all, and to declare "calibrated". */
const MIN_MEASURED_TO_SHOW = 4;
const MIN_MEASURED_TO_PASS = 8;
/** Running average weight of each new reading per direction (recent readings win as Android's calibration settles). */
const EMA = 0.2;
/** Consistency thresholds, ± % of the field strength. Calibrated = Good. */
const GOOD_PCT = 5;
const FAIR_PCT = 10;

/** Without a field model: Earth's field is ~25–65 µT anywhere. With one: expected strength ±25%. */
const FIELD_RANGE_UT: [number, number] = [22, 65];
const EXPECTED_TOLERANCE = 0.25;

const ANDROID_LABELS = ['Unreliable', 'Low', 'Medium', 'High'];
const GREEN = '#4cd964';
const YELLOW = '#ffd60a';
const ORANGE = '#ff9f0a';
const RING_CIRCUMFERENCE = 2 * Math.PI * 42; // matches r="42" in index.html

export type CompassCalibration = { open: () => void; close: () => void; isOpen: () => boolean };

type Direction = { mean: number; samples: number };

export function createCompassCalibration(onClose: () => void): CompassCalibration {
  const screen = document.getElementById('calibrate-screen')!;
  const title = document.getElementById('cal-title')!;
  const ring = document.getElementById('cal-ring') as unknown as SVGCircleElement;
  const percent = document.getElementById('cal-percent')!;
  const quality = document.getElementById('cal-quality')!;
  const detail = document.getElementById('cal-detail')!;
  const warning = document.getElementById('cal-warning')!;
  const doneBtn = document.getElementById('cal-done') as HTMLButtonElement;

  let listener: PluginListenerHandle | null = null;
  let directions = new Map<number, Direction>();
  let expectedUT: number | null = null;
  let calibrated = false;

  const fieldRange = (): [number, number] =>
    expectedUT ? [expectedUT * (1 - EXPECTED_TOLERANCE), expectedUT * (1 + EXPECTED_TOLERANCE)] : FIELD_RANGE_UT;

  /** ± % spread of the per-direction average strengths, over directions with enough samples. */
  function consistency(): { pct: number; measured: number } | null {
    const means = [...directions.values()].filter((d) => d.samples >= MIN_SAMPLES).map((d) => d.mean);
    if (means.length < MIN_MEASURED_TO_SHOW) return null;
    const sorted = [...means].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    return { pct: ((sorted[sorted.length - 1] - sorted[0]) / 2 / median) * 100, measured: means.length };
  }

  function render(r: CompassReading | null) {
    const progress = Math.min(1, directions.size / COVERAGE_GOAL);
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
    // At 0 the round line cap would still draw a dot at the top.
    ring.style.opacity = progress > 0 ? '1' : '0';
    ring.style.stroke = calibrated ? GREEN : '#4fc3f7';
    percent.textContent = calibrated ? '✓' : `${Math.round(progress * 100)}%`;
    title.textContent = calibrated ? '✓ Compass calibrated' : '🧭 Compass calibration';
    doneBtn.classList.toggle('primary', calibrated);
    if (!r) return;

    const c = consistency();
    if (!c) {
      quality.textContent = 'Consistency: keep turning the phone to measure';
    } else {
      const [label, color] = c.pct <= GOOD_PCT ? ['Good', GREEN] : c.pct <= FAIR_PCT ? ['Fair', YELLOW] : ['Poor', ORANGE];
      quality.innerHTML = `Consistency: <b style="color:${color}">±${c.pct.toFixed(1)}% · ${label}</b>`;
    }

    const strength = Math.hypot(r.x, r.y, r.z);
    const expected = expectedUT ? ` (expected ${Math.round(expectedUT)} µT here)` : '';
    const android = r.accuracy >= 0 && r.accuracy <= 3 ? ANDROID_LABELS[r.accuracy] : 'unknown';
    const heading = r.headingAccuracyDeg != null ? ` · heading ±${Math.round(r.headingAccuracyDeg)}°` : '';
    detail.textContent = `Field ${Math.round(strength)} µT${expected} · Android's rating: ${android}${heading}`;

    const [lo, hi] = fieldRange();
    warning.hidden = strength >= lo && strength <= hi;
    warning.textContent = `Magnetic interference (${Math.round(strength)} µT): move away from metal, magnets, laptops and speakers.`;
  }

  function onReading(r: CompassReading) {
    const n = Math.hypot(r.x, r.y, r.z);
    const [lo, hi] = fieldRange();
    // Only readings that look like the Earth's field (not a nearby magnet) count.
    if (n >= lo && n <= hi) {
      const [x, y, z] = [r.x / n, r.y / n, r.z / n];
      DIRECTIONS.forEach(([dx, dy, dz], i) => {
        if (x * dx + y * dy + z * dz < COVERED_DOT) return;
        const d = directions.get(i);
        if (d) {
          d.mean += (n - d.mean) * EMA;
          d.samples++;
        } else {
          directions.set(i, { mean: n, samples: 1 });
        }
      });
    }
    const c = consistency();
    if (directions.size >= COVERAGE_GOAL && c && c.measured >= MIN_MEASURED_TO_PASS && c.pct <= GOOD_PCT) calibrated = true;
    render(r);
  }

  async function open() {
    directions = new Map();
    calibrated = false;
    expectedUT = fieldModel()?.fieldStrengthUT ?? null;
    warning.hidden = true;
    detail.textContent = '';
    screen.hidden = false;
    render(null);
    if (!isNative) {
      quality.textContent = 'Compass calibration needs the Android app.';
      return;
    }
    quality.textContent = 'Waiting for the compass…';
    try {
      listener = await Compass.addListener('reading', onReading);
      await Compass.start();
    } catch (err) {
      quality.textContent = (err as Error).message || 'Compass not available.';
    }
  }

  function close() {
    listener?.remove();
    listener = null;
    if (isNative) Compass.stop().catch(() => {});
    screen.hidden = true;
    onClose();
  }

  doneBtn.addEventListener('click', close);
  return { open, close, isOpen: () => !screen.hidden };
}
