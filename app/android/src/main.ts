// Android app: stereo AR view + settings screen. Forked from web/src/main.ts (see PLAN.md, phase 4).
// Differences from the web app:
//   - the view starts right away on launch; settings open from the ⚙ button (top right) or a
//     long-press, and "Done" or Android back returns to the view
//   - live data only (no demo snapshot): planes come from the in-app engine (src/flights) around
//     the phone's GPS position, not from flight-service
//   - no voice assistant, no casting
//   - fullscreen, landscape and keep-screen-on are native (MainActivity), so the web workarounds
//     (requestFullscreen, wake lock, "tap to resume", popstate trick) are gone
//   - Android back = leave the view; backgrounding the app suspends camera/sensors/polling
//   - no phone presets: screen size and camera FOV are measured natively (any phone works), and the
//     in-headset calibration handles the rest
// Everything else (HUD, stereo layout, heading, calibration) is imported from web/src unchanged.

import { DEFAULT_IPD_MM, DEFAULT_SETTINGS, getPreset, loadSettings, pxPerMm, saveSettings } from '@web/config';
import type { Settings } from '@web/config';
import { describeStream, getZoom, getZoomRange, listCameras, setZoom, startCamera } from '@web/camera';
import { halfFovDeg, normalizeDeg, visibleHalfTan } from '@web/geo';
import { drawHud } from '@web/hud';
import { MAG_DECLINATION_DEG, startOrientation } from '@web/orientation';
import type { OrientationTracker } from '@web/orientation';
import type { PlaneFeed } from '@web/planes';
import { createStereoView } from '@web/stereo';
import type { StereoView } from '@web/stereo';
import { lensFov } from './camera-fov';
import type { LensFov } from './camera-fov';
import { declinationCorrectionDeg, fieldModel, updateFieldModel } from './compass';
import { createCompassCalibration } from './compass-calibration';
import { startLiveFeed } from './flights/feed';
import { watchPosition } from './flights/gps';
import type { GpsWatch } from './flights/gps';
import { exitApp, handleBackButton, handlePauseResume, requestLocationPermission } from './native';
import { measureScreenLongEdgeMm } from './screen-size';

// Desktop only (npm run dev): ?dev=1 = arrow keys set the heading, camera optional.
const DEV = new URLSearchParams(location.search).has('dev');

/** A typical ~6.3" phone: used only when the screen size or lens FOV can't be measured. */
const FALLBACK = getPreset('generic');

const settingsScreen = document.getElementById('settings-screen')!;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const ipdInput = document.getElementById('ipd-input') as HTMLInputElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
const doneBtn = document.getElementById('done-btn') as HTMLButtonElement;
const calibrateBtn = document.getElementById('calibrate-btn') as HTMLButtonElement;
/** Compass calibration screen, opened from settings; closing it returns to settings. */
const calibration = createCompassCalibration(() => (settingsScreen.hidden = false));
const settingsStatus = document.getElementById('settings-status')!;
const stereoEl = document.getElementById('stereo')!;

let settings: Settings = { ...DEFAULT_SETTINGS };
let view: StereoView | null = null;
let stream: MediaStream | null = null;
/** Measured FOV of the lens the camera stream came from; null = use the fallback estimate. */
let lens: LensFov | null = null;
/** Measured long edge of the screen in mm; null = unknown, use the fallback. */
let screenMm: number | null = null;
let orientation: OrientationTracker | null = null;
let feed: PlaneFeed | null = null;
let gps: GpsWatch | null = null;
/** App is in the background with the view open: camera, sensors and polling are stopped. */
let suspended = false;
let rafId = 0;
let devHeading = 0;
/** Latest computed half-FOV, for the calibration toast and debug line. */
let lastHalfFovDeg = 0;
let hudError = '';
let toast = '';
let toastTimer = 0;

// In-headset calibration. Locked by default so stray touches (cheek, headset edge) do nothing.
// Double-tap the middle to unlock; then middle tap = next setting, left/right = adjust.
// Re-locks after LOCK_AFTER_MS without a tap (except in 'info', which stays up).
type Mode = 'zoom' | 'tilt' | 'spacing' | 'shift' | 'size' | 'fov' | 'info';
const MODES: Mode[] = ['zoom', 'tilt', 'spacing', 'shift', 'size', 'fov', 'info'];
let mode: Mode | null = null;
let lockTimer = 0;
let lastMiddleTap = 0;
const LOCK_AFTER_MS = 6000;
const DOUBLE_TAP_MS = 400;
const LONG_PRESS_MS = 1500;
let longPressTimer = 0;
let longPressFired = false;

async function initSettings() {
  const saved = loadSettings();
  settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    // Not in the Android app: presets are replaced by measuring, data is always live,
    // and there's no voice or casting.
    presetId: FALLBACK.id,
    dataMode: 'live',
    voiceEnabled: false,
    castEnabled: false,
  };
  screenMm = await measureScreenLongEdgeMm();
  ipdInput.value = String(settings.ipdMm);
  radiusInput.value = settings.radiusKm == null ? '' : String(settings.radiusKm);
  await refreshCameraList();

  if (DEV) settingsStatus.textContent = 'Dev mode: ← → turn (hold Shift for 10°).';
}

/** Camera labels are only available after permission has been granted once. */
async function refreshCameraList() {
  const cams = await listCameras();
  cameraSelect.replaceChildren(new Option('Auto (rear)', ''));
  cams.forEach((c, i) => cameraSelect.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  cameraSelect.value = cams.some((c) => c.deviceId === settings.cameraId) ? settings.cameraId : '';
}

/** Blank or invalid = null (default radius, DEFAULT_RADIUS_KM in flights/nearby.ts). */
function parseRadius(value: string): number | null {
  const r = Number(value);
  if (!value.trim() || !Number.isFinite(r) || r <= 0) return null;
  return Math.min(400, Math.round(r));
}

function readSettingsFromForm() {
  const ipd = Number(ipdInput.value);
  settings = {
    ...settings,
    ipdMm: Number.isFinite(ipd) && ipd > 0 ? ipd : DEFAULT_IPD_MM,
    cameraId: cameraSelect.value,
    radiusKm: parseRadius(radiusInput.value),
  };
  radiusInput.value = settings.radiusKm == null ? '' : String(settings.radiusKm);
  saveSettings(settings);
}

function relayout() {
  if (!view) return;
  view.layout({
    pxPerMm: pxPerMm({ ...FALLBACK, screenWidthMm: screenMm ?? FALLBACK.screenWidthMm }),
    ipdMm: settings.ipdMm,
    offsetMm: settings.offsetMm,
    viewScale: settings.viewScale,
    tiltDeg: settings.tiltDeg,
  });
  renderOverlay();
}

/**
 * True-north heading of the rear camera. web/src/orientation.ts corrects magnetic north with Atlanta's
 * fixed declination; this swaps in the local declination from Earth's field model (compass.ts).
 */
function currentHeading(): number | null {
  if (DEV) return devHeading;
  const h = orientation?.get()?.headingDeg;
  return h == null ? null : normalizeDeg(h + declinationCorrectionDeg());
}

/** Per-frame: compute the visible FOV and draw the HUD canvas in both eyes. */
function frame() {
  if (!view) return;
  rafId = requestAnimationFrame(frame);

  const { width, height } = view.eyeSize();
  if (!width || !height) return;
  const video = view.eyes[0].video;
  const streamAspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
  const zoom = (stream && getZoom(stream)) || 1;
  const halfTan = visibleHalfTan(
    lens?.halfTan1x ?? FALLBACK.cameraHalfTan1x,
    zoom,
    width / height,
    streamAspect,
    settings.fovScale,
  );
  lastHalfFovDeg = halfFovDeg(halfTan);

  const feedState = feed?.get();
  const hud = {
    headingDeg: currentHeading(),
    halfTan,
    planes: feedState?.planes ?? [],
    status: feedState?.status ?? '',
    timeMs: performance.now(),
    voice: null,
  };
  // Both eyes get identical input (required for the images to fuse).
  for (const eye of view.eyes) drawHud(eye.ctx, width, height, hud);
}

/** DOM overlay: crosshair, calibration toast, errors, debug line. Redrawn on events, not per frame. */
function renderOverlay() {
  if (!view) return;
  let debug = '';
  if (mode === 'info') {
    const o = orientation?.get();
    const heading = currentHeading();
    const hdg = DEV ? `dev ${Math.round(devHeading)}°` : o && heading != null ? `${Math.round(heading)}° ${o.source}` : 'no compass';
    const model = fieldModel();
    const decl = model
      ? `decl ${model.declinationDeg > 0 ? '+' : ''}${model.declinationDeg.toFixed(1)}°${model.source === 'saved' ? ' (saved)' : ''}`
      : `decl ${MAG_DECLINATION_DEG}° (Atlanta default)`;
    const lensInfo = lens ? `camera ${lens.cameraId} ${Math.round(halfFovDeg(lens.halfTan1x) * 2)}°` : 'assumed';
    const screenInfo = screenMm ? `screen ${Math.round(screenMm)}mm` : `screen ~${FALLBACK.screenWidthMm}mm assumed`;
    debug = `<div class="debug">${hdg} · ${decl} · fov ${Math.round(lastHalfFovDeg * 2)}° (lens ${lensInfo}) · ${feed?.get().status ?? ''}<br>
      ${screenInfo} · tilt ${settings.tiltDeg}° · ${settings.ipdMm}mm · shift ${settings.offsetMm}mm · ${Math.round(settings.viewScale * 100)}% · ${stream ? describeStream(stream) : 'no camera'}</div>`;
  }
  const error = hudError ? `<div class="hud-error">${hudError}</div>` : '';
  const toastHtml = toast ? `<div class="toast">${toast}</div>` : '';
  const html = `<div class="crosshair"></div>${error}${toastHtml}${debug}`;
  for (const eye of view.eyes) eye.overlay.innerHTML = html;
}

/** Heading + plane data. Stopped while the app is in the background. */
function startTracking() {
  if (!DEV) orientation = startOrientation();
  const watch = watchPosition((pos) => updateFieldModel(pos.lat, pos.lon));
  gps = watch;
  feed = startLiveFeed({ radiusKm: settings.radiusKm, getPosition: watch.get });
}

function stopTracking() {
  orientation?.stop();
  feed?.stop();
  gps?.stop();
  orientation = null;
  feed = null;
  gps = null;
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  lens = null;
}

/** Looks up the exact FOV of the lens behind `s` (async; the fallback estimate is used until then). */
function identifyLens(s: MediaStream) {
  lensFov(s.getVideoTracks()[0]).then((l) => {
    if (stream !== s) return;
    lens = l;
    renderOverlay();
  });
}

function startErrorText(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'NotAllowedError') {
    return 'Camera permission denied. Allow it in Android Settings → Apps → SkyLens → Permissions.';
  }
  return `Could not start: ${e?.message ?? err}`;
}

/** Opens the AR view: on launch, and from settings ("Done" / back). On failure, settings show why. */
async function start() {
  if (view || doneBtn.disabled) return;
  readSettingsFromForm();
  doneBtn.disabled = true;
  settingsStatus.textContent = 'Starting…';

  try {
    const locationOk = await requestLocationPermission();
    try {
      stream = await startCamera(settings.cameraId || undefined);
    } catch (err) {
      if (!DEV) throw err;
      stream = null; // Dev mode works without a camera.
    }

    startTracking();
    view = createStereoView(stereoEl, stream);
    mode = null;
    longPressFired = false;
    suspended = false;
    settingsScreen.hidden = true;
    stereoEl.hidden = false;
    settingsBtn.hidden = false;
    settingsStatus.textContent = '';
    hudError = locationOk
      ? ''
      : 'Location permission denied: the app needs GPS to find planes near you. Allow it in Android Settings → Apps → SkyLens → Permissions.';
    relayout();
    rafId = requestAnimationFrame(frame);
    if (stream) {
      identifyLens(stream);
      watchForFrames(stream);
      applySavedZoom(stream);
    }
  } catch (err) {
    stopCamera();
    settingsStatus.textContent = startErrorText(err);
    settingsScreen.hidden = false;
  } finally {
    doneBtn.disabled = false;
  }
}

/** Applied after the view is showing so a slow zoom change can't stall startup. */
async function applySavedZoom(s: MediaStream) {
  const range = getZoomRange(s);
  if (!range) return;
  const target = settings.cameraZoom ?? range.min;
  await setZoom(s, Math.min(range.max, Math.max(range.min, target)));
  renderOverlay();
}

/** Surface a stuck camera instead of showing a silent black screen. */
function watchForFrames(s: MediaStream) {
  setTimeout(() => {
    if (!view || stream !== s) return;
    const video = view.eyes[0].video;
    if (video.videoWidth === 0) {
      const track = s.getVideoTracks()[0];
      hudError = `No camera frames (track ${track?.readyState ?? 'missing'}, video paused=${video.paused}). Open ⚙ settings and tap Done to retry.`;
      renderOverlay();
    }
  }, 3000);
}

/** App went to the background: release the camera, sensors and network polling. The view stays. */
function suspend() {
  if (!view || suspended) return;
  suspended = true;
  cancelAnimationFrame(rafId);
  stopCamera();
  stopTracking();
}

/** Back from the background: restart what suspend() stopped and reattach the camera to both eyes. */
async function resume() {
  if (!view || !suspended) return;
  suspended = false;
  startTracking();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(frame);
  try {
    const s = await startCamera(settings.cameraId || undefined);
    if (!view || suspended) {
      // Left the view (or went to the background again) while the camera was starting.
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    for (const eye of view.eyes) {
      eye.video.srcObject = s;
      eye.video.play().catch(() => {});
    }
    identifyLens(s);
    watchForFrames(s);
    applySavedZoom(s);
  } catch (err) {
    if (!DEV) {
      hudError = startErrorText(err);
      renderOverlay();
    }
  }
}

/** Closes the view and shows settings (⚙ button or long-press). Camera, sensors and polling stop. */
function openSettings() {
  cancelAnimationFrame(rafId);
  clearTimeout(lockTimer);
  stopCamera();
  stopTracking();
  suspended = false;
  view = null;
  stereoEl.replaceChildren();
  stereoEl.hidden = true;
  settingsBtn.hidden = true;
  settingsScreen.hidden = false;
  ipdInput.value = String(settings.ipdMm);
  refreshCameraList();
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

function modeLabel(): string {
  switch (mode) {
    case null:
      return 'locked';
    case 'zoom': {
      const z = stream && getZoom(stream);
      return `zoom ${z != null ? `${z.toFixed(1)}×` : '(n/a)'}`;
    }
    case 'tilt':
      return `tilt ${settings.tiltDeg > 0 ? '+' : ''}${settings.tiltDeg.toFixed(1)}°`;
    case 'size':
      return `size ${Math.round(settings.viewScale * 100)}%`;
    case 'spacing':
      return `spacing ${settings.ipdMm} mm`;
    case 'shift':
      return `shift ${settings.offsetMm > 0 ? '+' : ''}${settings.offsetMm} mm`;
    case 'fov':
      return `fov ${Math.round(lastHalfFovDeg * 2)}°`;
    case 'info':
      return 'info';
  }
}

async function adjust(direction: -1 | 1) {
  switch (mode) {
    case 'zoom': {
      if (!stream) return showToast('no camera');
      const range = getZoomRange(stream);
      if (!range) return showToast('zoom not supported');
      const current = getZoom(stream) ?? range.min;
      const next = clamp(round2(current + direction * Math.max(range.step, 0.1)), range.min, range.max);
      settings.cameraZoom = next;
      showToast(`zoom ${next.toFixed(1)}×`);
      await setZoom(stream, next);
      break;
    }
    case 'tilt':
      settings.tiltDeg = clamp(settings.tiltDeg + direction * 0.5, -15, 15);
      break;
    case 'size':
      settings.viewScale = clamp(round2(settings.viewScale + direction * 0.02), 0.6, 1);
      break;
    case 'spacing':
      settings.ipdMm = clamp(settings.ipdMm + direction, 50, 80);
      break;
    case 'shift':
      settings.offsetMm = clamp(settings.offsetMm + direction, -20, 20);
      break;
    case 'fov':
      settings.fovScale = clamp(round2(settings.fovScale + direction * 0.03), 0.5, 1.5);
      break;
    case 'info':
    case null:
      return;
  }
  saveSettings(settings);
  relayout();
  // The FOV is recomputed in the next frame; show the toast after it.
  if (mode === 'fov') requestAnimationFrame(() => requestAnimationFrame(() => showToast(modeLabel())));
  else if (mode !== 'zoom') showToast(modeLabel());
}

/** Cycles zoom → … → info → locked. */
function cycleMode() {
  const i = mode ? MODES.indexOf(mode) + 1 : 0;
  mode = i < MODES.length ? MODES[i] : null;
  showToast(mode === null ? 'calibration locked' : mode === 'info' ? 'info' : `◀ ▶ ${modeLabel()}`);
}

function armAutoLock() {
  clearTimeout(lockTimer);
  if (!mode || mode === 'info') return;
  lockTimer = window.setTimeout(() => {
    mode = null;
    showToast('calibration locked');
  }, LOCK_AFTER_MS);
}

function onViewTap(e: MouseEvent) {
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  const x = e.clientX / window.innerWidth;
  const middle = x >= 1 / 3 && x <= 2 / 3;
  if (mode === null) {
    if (!middle) return;
    const now = performance.now();
    if (now - lastMiddleTap < DOUBLE_TAP_MS) {
      lastMiddleTap = 0;
      cycleMode();
      armAutoLock();
    } else {
      lastMiddleTap = now;
    }
    return;
  }
  if (middle) cycleMode();
  else adjust(x < 1 / 3 ? -1 : 1);
  armAutoLock();
}

function showToast(text: string) {
  toast = text;
  renderOverlay();
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = '';
    renderOverlay();
  }, 1500);
}

doneBtn.addEventListener('click', start);
calibrateBtn.addEventListener('click', () => {
  settingsScreen.hidden = true;
  calibration.open();
});
// ⚙ sits outside #stereo, so its taps never reach the calibration tap handler.
settingsBtn.addEventListener('click', openSettings);
stereoEl.addEventListener('click', onViewTap);
// Long-press anywhere = settings (reachable without finding the ⚙ corner, e.g. through the headset).
stereoEl.addEventListener('pointerdown', () => {
  clearTimeout(longPressTimer);
  longPressTimer = window.setTimeout(() => {
    longPressFired = true;
    openSettings();
  }, LONG_PRESS_MS);
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
  stereoEl.addEventListener(type, () => clearTimeout(longPressTimer));
}
window.addEventListener('keydown', (e) => {
  if (!DEV || !view) return;
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft') devHeading = normalizeDeg(devHeading - step);
  else if (e.key === 'ArrowRight') devHeading = normalizeDeg(devHeading + step);
});
window.addEventListener('resize', relayout);
// Back: in compass calibration = back to settings; in settings = back to the view; in the view = leave the app.
handleBackButton(() => {
  if (calibration.isOpen()) calibration.close();
  else if (view) exitApp();
  else start();
});
handlePauseResume(suspend, resume);
// Keep the info line's heading fresh while it's showing.
setInterval(() => {
  if (view && mode === 'info') renderOverlay();
}, 500);

// Straight into the view on launch; settings only show if it can't start (e.g. camera denied).
initSettings().then(start);
