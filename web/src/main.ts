import { createStreetMap } from './street-map';
import { createMapState, applyMapAction, compassBuses, compassLimitKm } from './map-state';
import type { MapAction } from './map-state';
import { DEFAULT_IPD_MM, TRANSIT_SETTINGS as DEFAULT_SETTINGS, PRESETS, detectPreset, getPreset, loadSettings, pxPerMm, saveSettings } from './config';
import type { Settings } from './config';
import { describeStream, getZoom, getZoomRange, listCameras, setZoom, startCamera } from './camera';
import { halfFovDeg, normalizeDeg, visibleHalfTan } from './geo';
import { drawHud } from './hud';
import type { VoiceHud } from './hud';
import { startVoice } from './voice';
import type { VoiceHandle } from './voice';
import { createTransitConversation } from './voice/transit';
import { requestOrientationPermission, startOrientation } from './orientation';
import type { OrientationTracker } from './orientation';
import { startBusFeed, watchPosition, REITZ_CENTER, createBusFocus } from './buses';
import type { BusFeed } from './buses';
import { createStereoView } from './stereo';
import type { StereoView } from './stereo';
import { createCastCompositor } from './cast/compositor';
import type { CastCompositor } from './cast/compositor';
import { startCastPublisher } from './cast/publisher';
import type { CastPublisher } from './cast/publisher';
// URL options:
//   ?dev=1          desktop dev mode: arrow keys set the heading, camera optional, no fullscreen
//   ?orient=event   force deviceorientation events instead of AbsoluteOrientationSensor
const params = new URLSearchParams(location.search);
const DEV = params.has('dev');
const CAMERA_OFF = DEV && params.get('camera') === 'off';
const FORCE_ORIENT_EVENTS = params.get('orient') === 'event';

const startScreen = document.getElementById('start-screen')!;
const presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
const ipdInput = document.getElementById('ipd-input') as HTMLInputElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const dataSelect = document.getElementById('data-select') as HTMLSelectElement;
const viewSelect = document.getElementById('view-select') as HTMLSelectElement;
const radiusInput = document.getElementById('radius-input') as HTMLInputElement;
const compassInput = document.getElementById('compass-distance') as HTMLInputElement;
const compassAll = document.getElementById('compass-all') as HTMLInputElement;
const castCheck = document.getElementById('cast-check') as HTMLInputElement;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const startStatus = document.getElementById('start-status')!;
const stereoEl = document.getElementById('stereo')!;
const voiceCheck = document.getElementById('voice-check') as HTMLInputElement;
const assistantPanel = document.getElementById('assistant-panel') as HTMLDialogElement;
const questionInput = document.getElementById('assistant-question') as HTMLInputElement;
const assistantAnswer = document.getElementById('assistant-answer')!;

let settings: Settings = { ...DEFAULT_SETTINGS };
let view: StereoView | null = null;
let stream: MediaStream | null = null;
let orientation: OrientationTracker | null = null;
let feed: BusFeed | null = null;
let gps: ReturnType<typeof watchPosition> | null = null;
let cast: { compositor: CastCompositor; publisher: CastPublisher } | null = null;
let castStatus = '';
let rafId = 0;
let devHeading = 0;

let streetMap: ReturnType<typeof createStreetMap> | null = null;
let mapState = createMapState(5);
function dispatchMap(action: MapAction) { mapState = applyMapAction(mapState, action); renderOverlay(); }

let busFocus = createBusFocus();
let wakeLock: WakeLockSentinel | null = null;
let orientationMessage = '';
let session = 0;
let cameraFrameTimer = 0;
let focusedBusId: string | null = null;
let voice: VoiceHandle | null = null;
let voiceHud: VoiceHud = { state: 'idle', transcript: null, answer: null, error: null };
let answerTimer = 0;
const conversation = createTransitConversation(() => ({
  focusedBusId, position: feed?.get().position ?? null, radiusKm: settings.radiusKm ?? 5,
  map: { mode: mapState.mode, extentKm: mapState.extentKm },
}), (actions) => {
  actions.forEach(dispatchMap);
  const messages: string[] = [];
  if (actions.some(a => a.type === 'set_map_mode')) messages.push(mapState.mode === 'expanded' ? 'Map expanded.' : 'Map returned to compact view.');
  if (actions.some(a => a.type === 'set_map_extent')) messages.push(`Map range set to ${Number(mapState.extentKm.toFixed(2))} kilometers.`);
  return messages.join(' ');
});

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

async function initStartScreen() {
  for (const p of PRESETS) presetSelect.add(new Option(p.label, p.id));
  const saved = loadSettings('transitlens-settings-v1');
  settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    presetId: saved.presetId ?? (await detectPreset()).id,
  };
  presetSelect.value = settings.presetId;
  ipdInput.value = String(settings.ipdMm);
  dataSelect.value = 'live';
  viewSelect.value = settings.viewMode;
  radiusInput.value = settings.radiusKm == null ? '' : String(settings.radiusKm);
  compassInput.value = String(settings.compassDistanceMiles ?? 1);
  compassAll.checked = settings.compassDistanceMiles === null;
  compassInput.disabled = compassAll.checked;
  castCheck.checked = settings.castEnabled;
  voiceCheck.checked = settings.voiceEnabled;
  await refreshCameraList();

  if (DEV) startStatus.textContent = 'Dev mode: ← → turn (hold Shift for 10°).';
  else if (!window.isSecureContext) {
    startStatus.textContent = 'Not a secure context: camera and sensors need HTTPS (use ngrok) or localhost.';
  }
}

/** Camera labels are only available after permission has been granted once. */
async function refreshCameraList() {
  const cams = await listCameras();
  cameraSelect.replaceChildren(new Option('Auto (rear)', ''));
  cams.forEach((c, i) => cameraSelect.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  cameraSelect.value = cams.some((c) => c.deviceId === settings.cameraId) ? settings.cameraId : '';
}

/** Blank or invalid uses the 5 km bus-service default. */
function parseRadius(value: string): number | null {
  const r = Number(value);
  if (!value.trim() || !Number.isFinite(r) || r <= 0) return null;
  return Math.min(400, r);
}

function readSettingsFromForm() {
  const ipd = Number(ipdInput.value);
  settings = {
    ...settings,
    presetId: presetSelect.value,
    ipdMm: Number.isFinite(ipd) && ipd > 0 ? Math.min(80, Math.max(50, ipd)) : DEFAULT_IPD_MM,
    cameraId: cameraSelect.value,
    dataMode: 'live',
    viewMode: 'ar',
    voiceEnabled: voiceCheck.checked,
    showGrounded: true,
    radiusKm: parseRadius(radiusInput.value),
    compassDistanceMiles: compassAll.checked ? null : (Number(compassInput.value) > 0 && Number.isFinite(Number(compassInput.value)) ? Number(compassInput.value) : 1),
    castEnabled: castCheck.checked,
    freezePlanes: false,
  };
  radiusInput.value = settings.radiusKm == null ? '' : String(settings.radiusKm);
  compassInput.value = String(settings.compassDistanceMiles ?? 1);
  saveSettings(settings, 'transitlens-settings-v1');
}

/** Fullscreen + landscape lock. Must be kicked off synchronously from the tap. */
async function enterImmersive() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await (screen.orientation as any).lock?.('landscape');
  } catch {
    // iOS and desktop don't support these; the view still works.
  }
}

async function keepScreenOn() {
  try {
    if (wakeLock && !wakeLock.released) return;
    const activeSession = session;
    const lock = await navigator.wakeLock?.request('screen') ?? null;
    if (activeSession !== session || !view) { await lock?.release(); return; }
    wakeLock = lock;
  } catch {
    // Not fatal.
  }
}

function relayout() {
  if (!view) return;
  view.layout({
    pxPerMm: pxPerMm(getPreset(settings.presetId)),
    ipdMm: settings.ipdMm,
    offsetMm: settings.offsetMm,
    viewScale: settings.viewScale,
    tiltDeg: settings.tiltDeg,
  });
  renderOverlay();
}

function currentHeading(): number | null {
  if (DEV) return devHeading;
  return orientation?.get()?.headingDeg ?? null;
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
  const halfTan = visibleHalfTan(getPreset(settings.presetId).cameraHalfTan1x, zoom, width / height, streamAspect, settings.fovScale);
  lastHalfFovDeg = halfFovDeg(halfTan);

  const feedState = feed?.get();
  const allBuses = feedState?.buses ?? [];
  const buses = compassBuses(allBuses, compassLimitKm(settings.compassDistanceMiles === null ? null : settings.compassDistanceMiles ?? 1));
  const timeMs = performance.now();
  const headingDeg = currentHeading();
  const selectedFocusId = busFocus.update(buses, headingDeg, timeMs);
  focusedBusId = selectedFocusId;
  mapState = { ...mapState, center: feedState?.position ?? null, responseCenter: feedState?.responseCenter ?? null, headingDeg };
  streetMap?.update({ state: mapState, buses: allBuses, focusId: selectedFocusId, halfFov: lastHalfFovDeg });
  const hud = {
    headingDeg, halfTan, planes: buses,
    status: [feedState?.status ?? '', orientationMessage, orientation?.get()?.northReference === 'magnetic' ? 'Magnetic heading - true-north correction pending' : '', !DEV && headingDeg == null ? 'Compass unavailable - check motion permission' : ''].filter(Boolean).join(' · '),
    timeMs, voice: voiceHud,
    selectedFocusId, mapFrame: streetMap?.get(), expandedMap: mapState.mode === 'expanded',
  };
  // Selection is already resolved. Every renderer receives the same state.
  const [left, right] = view.eyes;
  drawHud(left.ctx, width, height, hud);
  drawHud(right.ctx, width, height, hud);

  if (cast) {
    // The cast frame has its own aspect, so its visible FOV differs from an eye's.
    const castHalfTan = visibleHalfTan(
          getPreset(settings.presetId).cameraHalfTan1x,
          zoom,
          cast.compositor.aspect,
          streamAspect,
          settings.fovScale,
        );
    const source = video.videoWidth ? video : null;
    cast.compositor.draw(source, hud.timeMs, (ctx, w, h) => {
      drawHud(ctx, w, h, { ...hud, halfTan: castHalfTan });
      if (mapState.mode === 'compact') drawCastCrosshair(ctx, w, h);
    });
  }
}

/** The headset's crosshair is a DOM element, so the cast frame draws its own. */
function drawCastCrosshair(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function startCasting() {
  const compositor = createCastCompositor();
  const publisher = startCastPublisher(compositor.stream, (s) => {
    castStatus = s;
    if (mode === 'info') renderOverlay();
  });
  cast = { compositor, publisher };
}

function stopCasting() {
  cast?.publisher.stop();
  cast?.compositor.stop();
  cast = null;
  castStatus = '';
}

/** DOM overlay: crosshair, calibration toast, errors, debug line. Redrawn on events, not per frame. */
function renderOverlay() {
  if (!view) return;
  let debug = '';
  if (mode === 'info') {
    const o = orientation?.get();
    const hdg = DEV ? `dev ${Math.round(devHeading)}°` : o ? `${Math.round(o.headingDeg)}° ${o.source}` : 'no compass';
    const castInfo = cast ? ` · cast ${castStatus}` : '';
    debug = `<div class="debug">${hdg} · fov ${Math.round(lastHalfFovDeg * 2)}° · ${feed?.get().status ?? ''}${castInfo}<br>
      tilt ${settings.tiltDeg}° · ${settings.ipdMm}mm · shift ${settings.offsetMm}mm · ${Math.round(settings.viewScale * 100)}% · ${stream ? describeStream(stream) : 'no camera'}</div>`;
  }
  const error = hudError ? `<div class="hud-error">${hudError}</div>` : '';
  const resume =
    !DEV && !document.fullscreenElement ? '<div class="hud-hint">Rotate to landscape · long-press for settings</div>' : '';
  const toastHtml = toast ? `<div class="toast">${toast}</div>` : '';
  const controls = `<div class="map-controls"><button data-assistant>Ask Gemini</button><button data-map="toggle">${mapState.mode === 'expanded' ? 'Close' : 'Map'}</button><button data-map="in" aria-label="Zoom map in">+</button><button data-map="out" aria-label="Zoom map out">−</button></div>`;
  const credits = '<div class="map-credits" data-map-credit><a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></div>';
  const html = `${credits}${mapState.mode === 'compact' ? '<div class="crosshair"></div>' : ''}${controls}${error}${resume}${toastHtml}${debug}`;
  for (const eye of view.eyes) eye.overlay.innerHTML = html;
}

async function start() {
  if (startBtn.disabled) return;
  const activeSession = ++session;
  readSettingsFromForm();
  conversation.reset();
  focusedBusId = null;
  voiceHud = { state: 'idle', transcript: null, answer: null, error: null, wakeEnabled: settings.voiceEnabled };
  assistantAnswer.textContent = '';
  // Initialize recognition and audio inside the Start gesture, before camera awaits.
  voice = startVoice({
    listenForWake: settings.voiceEnabled,
    onCaptureStart: () => conversation.capture(),
    requestAnswer: (question, signal) => conversation.ask(question, signal),
    ttsEndpoint: null,
    onStateChange: state => { voiceHud.state = state; },
    onTranscript: text => {
      clearTimeout(answerTimer);
      voiceHud = { ...voiceHud, transcript: text, answer: null, error: null };
      assistantAnswer.textContent = 'Thinking…';
    },
    onAnswer: text => {
      voiceHud.answer = text;
      assistantAnswer.textContent = text;
      answerTimer = window.setTimeout(() => { voiceHud.answer = null; voiceHud.transcript = null; }, 25000);
    },
    onError: message => {
      voiceHud.error = message.includes('not supported') ? 'Use Ask Gemini to type a question' : message;
    },
  });
  // Both must start synchronously inside the tap (user-gesture requirements).
  const orientPermission = DEV ? Promise.resolve(true) : requestOrientationPermission();
  const immersive = DEV ? Promise.resolve() : enterImmersive();
  startBtn.disabled = true;
  startStatus.textContent = 'Starting camera…';

  try {
    hudError = '';
    if (CAMERA_OFF) { stream = null; hudError = 'Camera disabled - desktop blank background'; }
    else {
      try { stream = await startCamera(settings.cameraId || undefined); }
      catch { stream = null; hudError = 'Camera unavailable - blank background'; }
    }
    if (activeSession !== session) { stream?.getTracks().forEach(t => t.stop()); stream = null; return; }
    startStatus.textContent = 'Entering Cardboard…';
    await Promise.race([immersive, new Promise((r) => setTimeout(r, 1500))]);
    orientationMessage = await orientPermission ? '' : 'Motion permission denied - enable it and restart';
    if (activeSession !== session) return;

    if (!DEV) orientation = startOrientation(FORCE_ORIENT_EVENTS, () => feed?.get().declinationDeg ?? null);
    busFocus = createBusFocus();
    if (!DEV) gps = watchPosition();
    feed = startBusFeed({
      getPosition: () => DEV ? REITZ_CENTER : gps?.get() ?? null,
      positionStatus: () => DEV ? 'DESKTOP · fixed Reitz Union position' : gps?.status() ?? 'Waiting for GPS',
      radiusKm: settings.radiusKm ?? 5,
    });
    mapState = createMapState(settings.radiusKm ?? 5);
    streetMap = createStreetMap();
    view = createStereoView(stereoEl, stream);
    mode = null;
    longPressFired = false;
    // Swallow the Android back gesture while in the view (see popstate handler).
    history.pushState({ arView: true }, '');
    startScreen.hidden = true;
    stereoEl.hidden = false;
    startStatus.textContent = '';
    relayout();
    void keepScreenOn();
    rafId = requestAnimationFrame(frame);
    if (settings.castEnabled) startCasting();
    if (stream) {
      watchForFrames(stream);
      applySavedZoom(stream);
    }
  } catch (err) {
    startStatus.textContent = `Could not start: ${(err as Error).message}`;
    stop();
  } finally {
    startBtn.disabled = false;
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
  cameraFrameTimer = window.setTimeout(() => {
    if (!view || stream !== s) return;
    const video = view.eyes[0].video;
    if (video.videoWidth === 0) {
      const track = s.getVideoTracks()[0];
      hudError = `No camera frames (track ${track?.readyState ?? 'missing'}, video paused=${video.paused}). Swipe back and retry.`;
      renderOverlay();
    }
  }, 3000);
}

/** Back to the start screen (e.g. after the Android back gesture exits fullscreen). */
function stop() {
  session++;
  voice?.stop();
  voice = null;
  conversation.reset();
  focusedBusId = null;
  clearTimeout(answerTimer);
  assistantPanel.close();
  clearTimeout(cameraFrameTimer);
  void wakeLock?.release();
  wakeLock = null;
  clearTimeout(toastTimer);
  clearTimeout(longPressTimer);
  toast = '';
  lastMiddleTap = 0;
  stopCasting();
  streetMap?.stop();
  streetMap = null;
  cancelAnimationFrame(rafId);
  clearTimeout(lockTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (history.state?.arView) history.back();
  stream?.getTracks().forEach((t) => t.stop());
  orientation?.stop();
  feed?.stop();
  gps?.stop();
  stream = null;
  orientation = null;
  feed = null;
  gps = null;
  view = null;
  stereoEl.replaceChildren();
  stereoEl.hidden = true;
  startScreen.hidden = false;
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
  saveSettings(settings, 'transitlens-settings-v1');
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
  if ((e.target as Element).closest('[data-assistant]')) {
    conversation.capture();
    assistantPanel.showModal();
    questionInput.focus();
    return;
  }
  if ((e.target as Element).closest('[data-map-credit]')) return;
  const control = (e.target as Element).closest<HTMLButtonElement>('[data-map]');
  if (control) {
    if (control.dataset.map === 'toggle') dispatchMap({ type: 'set_map_mode', mode: mapState.mode === 'compact' ? 'expanded' : 'compact' });
    else dispatchMap({ type: 'set_map_extent', extentKm: mapState.extentKm * (control.dataset.map === 'in' ? 0.5 : 2) });
    return;
  }
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  // Fullscreen is optional. Calibration taps always continue, even after rejection.
  if (!DEV && document.fullscreenEnabled && !document.fullscreenElement) {
    void enterImmersive().then(renderOverlay);
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

compassAll.addEventListener('change', () => { compassInput.disabled = compassAll.checked; });
startBtn.addEventListener('click', start);
stereoEl.addEventListener('click', onViewTap);
// Long-press anywhere = back to the start screen (the deliberate way out).
stereoEl.addEventListener('pointerdown', (e) => {
  if ((e.target as Element).closest('[data-map], [data-map-credit], [data-assistant]')) return;
  clearTimeout(longPressTimer);
  longPressTimer = window.setTimeout(() => {
    longPressFired = true;
    stop();
  }, LONG_PRESS_MS);
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
  stereoEl.addEventListener(type, () => clearTimeout(longPressTimer));
}
window.addEventListener('keydown', (e) => {
  if (assistantPanel.open) return;
  if (view && ['m', 'M', '+', '=', '-', 'Escape'].includes(e.key)) {
    e.preventDefault();
    if (e.key === 'Escape') { if (mapState.mode === 'expanded') dispatchMap({ type: 'set_map_mode', mode: 'compact' }); else stop(); }
    else if (e.key.toLowerCase() === 'm') dispatchMap({ type: 'set_map_mode', mode: mapState.mode === 'compact' ? 'expanded' : 'compact' });
    else dispatchMap({ type: 'set_map_extent', extentKm: mapState.extentKm * (e.key === '-' ? 2 : 0.5) });
    return;
  }
  if (!DEV || !view) return;
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft') devHeading = normalizeDeg(devHeading - step);
  else if (e.key === 'ArrowRight') devHeading = normalizeDeg(devHeading + step);

});
// Leaving fullscreen (often an accidental back-swipe from the headset edge) no longer exits the
// view; calibration remains available without fullscreen.
document.addEventListener('fullscreenchange', renderOverlay);
window.addEventListener('popstate', () => {
  if (view) history.pushState({ arView: true }, '');
});
window.addEventListener('resize', relayout);
window.visualViewport?.addEventListener('resize', relayout);
window.addEventListener('pagehide', () => { if (view || startBtn.disabled) stop(); });
screen.orientation?.addEventListener('change', relayout);
document.addEventListener('visibilitychange', () => {
  // Wake lock is released when the tab is hidden; re-acquire on return.
  if (document.visibilityState === 'visible' && view) keepScreenOn();
});
// Keep the info line's heading fresh while it's showing.
setInterval(() => {
  if (view && mode === 'info') renderOverlay();
}, 500);

initStartScreen();

document.getElementById('assistant-close')!.addEventListener('click', () => assistantPanel.close());
document.getElementById('assistant-form')!.addEventListener('submit', e => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question || !voice) return;
  questionInput.value = '';
  void voice.ask(question);
});
assistantPanel.addEventListener('click', e => {
  const prompt = (e.target as Element).closest<HTMLButtonElement>('[data-question]')?.dataset.question;
  if (prompt && voice) void voice.ask(prompt);
});
