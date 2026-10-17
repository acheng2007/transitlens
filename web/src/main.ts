import { startDemoFeed, demoPattern } from './demo';
import { createJourneyState, reduceJourney, arrivalLabel } from './journey-state';
import { haversineKm } from './geo';
import type { TransitAction } from '../../shared/assistant';
import { createStreetMap } from './street-map';
import { createPatternCache, createRouteSelection } from './transit-data';
import { createMapState, applyMapAction, compassBuses, compassLimitKm } from './map-state';
import type { MapAction } from './map-state';
import { DEFAULT_IPD_MM, TRANSIT_SETTINGS as DEFAULT_SETTINGS, PRESETS, detectPreset, getPreset, loadSettings, pxPerMm, saveSettings } from './config';
import type { Settings, ThemeChoice } from './config';
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
import { createMonoView, createStereoView } from './stereo';
import type { View } from './stereo';
import { showPhoneLink } from './phone-link';
import { startHome } from './home';
import { renderPermissions } from './permissions';
import { initDiscovery, renderTripChoices, updateAssistantFeedback, updateCopilotConnection } from './discovery';
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
const permList = document.getElementById('perm-list')!;
const modeCards = [...document.querySelectorAll<HTMLElement>('[data-mode-view]')];
const settingsEl = document.getElementById('settings')!;
const themeButtons = [...document.querySelectorAll<HTMLElement>('[data-theme-choice]')];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const voiceCheck = document.getElementById('voice-check') as HTMLInputElement;
const assistantPanel = document.getElementById('assistant-panel') as HTMLDialogElement;
const questionInput = document.getElementById('assistant-question') as HTMLInputElement;
const assistantAnswer = document.getElementById('assistant-answer')!;

/** Resolved light/dark theme for the page, the HUD canvas and the map. */
const currentTheme = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function applyTheme() {
  const choice: ThemeChoice = settings.theme ?? 'system';
  const theme = choice === 'system' ? (darkQuery.matches ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0E0F10' : '#FAFAF8');
  for (const b of themeButtons) {
    const on = b.dataset.themeChoice === choice;
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', String(on));
  }
}
for (const b of themeButtons) {
  b.addEventListener('click', () => {
    settings.theme = b.dataset.themeChoice as ThemeChoice;
    saveSettings(settings, 'transitlens-settings-v1');
    applyTheme();
  });
}
darkQuery.addEventListener('change', () => { if ((settings.theme ?? 'system') === 'system') applyTheme(); });

/** Home screen feed (nearby cards + live indicator); stopped while the AR view runs. */
let home: ReturnType<typeof startHome> | null = null;
function restartHome() {
  home?.stop();
  home = startHome({ dev: DEV, radiusKm: () => settings.radiusKm ?? 5 });
}

function openSettings() {
  settingsEl.hidden = false;
  void renderPermissions(permList);
}
function closeSettings() {
  if (settingsEl.hidden) return;
  settingsEl.hidden = true;
  const radius = settings.radiusKm;
  readSettingsFromForm();
  if (settings.radiusKm !== radius) restartHome();
}
document.getElementById('settings-open')!.addEventListener('click', openSettings);
document.getElementById('settings-done')!.addEventListener('click', closeSettings);

/** Phone view (one full-screen image, no headset) vs Cardboard (two eyes). */
const isMobileView = () => settings.viewMode === 'mobile' || settings.viewMode === 'handheld';

/** Mirrors the hidden view select into the mode cards, and hides Cardboard-only settings in phone view. */
function syncModeCards() {
  for (const card of modeCards) {
    const on = card.dataset.modeView === viewSelect.value;
    card.classList.toggle('is-selected', on);
    card.setAttribute('aria-checked', String(on));
  }
  for (const el of document.querySelectorAll<HTMLElement>('.cardboard-only')) el.hidden = viewSelect.value !== 'ar';
}
for (const card of modeCards) {
  const pick = () => { viewSelect.value = card.dataset.modeView!; syncModeCards(); };
  card.addEventListener('click', pick);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
}

/** Live readouts and filled tracks for the start-screen sliders. */
const SLIDERS: [HTMLInputElement, string, (v: number) => string][] = [
  [radiusInput, 'radius-out', (v) => `${v} km`],
  [compassInput, 'compass-out', (v) => `${v} mi`],
  [ipdInput, 'ipd-out', (v) => `${v} mm`],
];
function syncSliders() {
  for (const [input, outId, fmt] of SLIDERS) {
    const min = Number(input.min), max = Number(input.max), v = Number(input.value);
    input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    document.getElementById(outId)!.textContent = input.disabled ? 'All' : fmt(v);
  }
}


let settings: Settings = { ...DEFAULT_SETTINGS };
let view: View | null = null;
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
let journeyState = createJourneyState();
let assistantSource = 'Ready';
let patterns: ReturnType<typeof createPatternCache> | null = null;
let routeSelection = createRouteSelection();
function dispatchMap(action: MapAction) { mapState = applyMapAction(mapState, action); renderOverlay(); }

let busFocus = createBusFocus();
/** When the current selection began, so both eyes animate the card identically. */
let lastFocusId: string | null = null;
let focusSinceMs = 0;
let wakeLock: WakeLockSentinel | null = null;
let orientationMessage = '';
let session = 0;
let cameraFrameTimer = 0;
let focusedBusId: string | null = null;
let voice: VoiceHandle | null = null;
let voiceHud: VoiceHud = { state: 'idle', transcript: null, answer: null, error: null };
let answerTimer = 0;
const conversation = createTransitConversation(() => ({
  dataMode: settings.dataMode === 'demo' ? 'demo' : 'live',
  destinationQuery: journeyState.plan?.query ?? null,
  selectedJourneyId: journeyState.selectedJourneyId,
  focusedBusId, position: feed?.get().position ?? null, radiusKm: settings.radiusKm ?? 5,
  map: { mode: mapState.mode, extentKm: mapState.extentKm },
}), applyAssistantActions, reply => {
  assistantSource = `${reply.demo ? 'DEMO DATA · ' : ''}${reply.source === 'gemini' ? 'Gemini API' : reply.source === 'scripted' ? 'Scripted commands' : 'Local tools · Gemini offline'}`;
  renderJourneyOptions();
  renderOverlay();
});

function applyAssistantActions(actions: TransitAction[]): string {
  const confirmations: string[] = [];
  for (const action of actions) {
    if (action.type === 'set_map_mode' || action.type === 'set_map_extent') {
      dispatchMap(action);
      confirmations.push(action.type === 'set_map_mode' ? (mapState.mode === 'expanded' ? 'Map expanded.' : 'Map returned to compact view.') : `Map range set to ${Number(mapState.extentKm.toFixed(2))} kilometers.`);
      continue;
    }
    journeyState = reduceJourney(journeyState, action);
    if (action.type === 'clear_guidance') { dispatchMap({ type: 'set_map_mode', mode: 'compact' }); confirmations.push('Guidance canceled. Back to exploring.'); }
    else {
      dispatchMap({ type: 'set_map_mode', mode: 'expanded' });
      const center = feed?.get().position;
      if (center) {
        const points = journeyState.routes.flatMap(r => r.shape);
        const extent = points.reduce((max,p) => Math.max(max,haversineKm(center.lat,center.lon,p.lat,p.lon)),0.3);
        dispatchMap({ type: 'set_map_extent', extentKm: Math.min(400,extent*1.2) });
      }
      if (action.type === 'show_journeys' && !actions.some(a => a.type === 'start_guidance')) {
        const plan = action.plan;
        if (plan.status === 'ambiguous') confirmations.push(`I found several places. Which stop do you mean: ${plan.destinations.slice(0,3).map(s => s.name).join(', ')}?`);
        else if (plan.options.length) confirmations.push(`I found ${plan.options.length} direct ${plan.options.length === 1 ? 'option' : 'options'} to ${plan.query}. Route ${plan.options[0].routeId} boards at ${plan.options[0].boardingStop.name}. Say take the first option, or choose a route.`);
        else confirmations.push(plan.status === 'unavailable' ? 'Route data is unavailable.' : `No direct trip to ${plan.query} was found with a boarding stop within half a mile. Try another destination or stop.`);
        if (plan.networkStatus !== 'available') confirmations.push(`Route catalog is ${plan.networkStatus}; results may be incomplete or outdated.`);
      }
      if (action.type === 'show_routes') confirmations.push(`Highlighted route ${action.routes[0].routeId} and its stops.`);
      if (action.type === 'start_guidance') {
        const j = action.journey;
        confirmations.push(`Take route ${j.routeId} ${j.direction.toLowerCase()} from ${j.boardingStop.name} to ${j.alightingStop.name}. ${arrivalLabel(j)}. Follow the stop bearing; this is approximate direction, not walking directions.`);
      }
    }
  }
  renderJourneyOptions();
  return confirmations.join(' ');
}

function renderJourneyOptions() {
  const host = document.getElementById('journey-options')!;
  document.getElementById('assistant-source')!.textContent = assistantSource;
  renderTripChoices(host, journeyState, id => {
    journeyState = { ...journeyState, selectedJourneyId: id };
    renderJourneyOptions();
    void voice?.ask('Guide me to the selected boarding stop');
  }, stopId => { void voice?.ask(`Show routes to ${stopId}`); });
}

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
/** Phone view has no lenses: only camera zoom, FOV and info apply. */
const MOBILE_MODES: Mode[] = ['zoom', 'fov', 'info'];
const modes = () => (isMobileView() ? MOBILE_MODES : MODES);
let mode: Mode | null = null;
let lockTimer = 0;
let lastMiddleTap = 0;
const LOCK_AFTER_MS = 6000;
const DOUBLE_TAP_MS = 400;
const LONG_PRESS_MS = 1500;
let longPressTimer = 0;
let longPressFired = false;

async function initStartScreen() {
  void showPhoneLink();
  for (const p of PRESETS) presetSelect.add(new Option(p.label, p.id));
  const saved = loadSettings('transitlens-settings-v1');
  settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    presetId: saved.presetId ?? (await detectPreset()).id,
  };
  presetSelect.value = settings.presetId;
  ipdInput.value = String(settings.ipdMm);
  dataSelect.value = params.get('demo') === '1' ? 'demo' : settings.dataMode === 'demo' ? 'demo' : 'live';
  viewSelect.value = settings.viewMode === 'ar' ? 'ar' : 'mobile';
  syncModeCards();
  radiusInput.value = String(settings.radiusKm ?? 5);
  compassInput.value = String(settings.compassDistanceMiles ?? 1);
  compassAll.checked = settings.compassDistanceMiles === null;
  compassInput.disabled = compassAll.checked;
  castCheck.checked = settings.castEnabled;
  voiceCheck.checked = settings.voiceEnabled;
  applyTheme();
  syncSliders();
  void renderPermissions(permList);
  restartHome();
  await refreshCameraList();

  void fetch('/api/voice/health', { signal: AbortSignal.timeout(5000) }).then(r => {
    if (!r.ok) throw new Error('Copilot service unavailable');
    return r.json();
  }).then(data => {
    if (typeof data.hasKey !== 'boolean') throw new Error('Invalid copilot health response');
    document.getElementById('connection-status')!.textContent = data.hasKey ? 'Gemini key configured' : 'Local commands · add Gemini key';
    updateCopilotConnection(data.hasKey);
  }).catch(() => { document.getElementById('connection-status')!.textContent = 'Copilot service unavailable'; updateCopilotConnection(null); });
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
    dataMode: dataSelect.value === 'demo' ? 'demo' : 'live',
    viewMode: viewSelect.value === 'ar' ? 'ar' : 'mobile',
    voiceEnabled: voiceCheck.checked,
    radiusKm: parseRadius(radiusInput.value),
    compassDistanceMiles: compassAll.checked ? null : (Number(compassInput.value) > 0 && Number.isFinite(Number(compassInput.value)) ? Number(compassInput.value) : 1),
    castEnabled: castCheck.checked,
  };
  radiusInput.value = String(settings.radiusKm ?? 5);
  compassInput.value = String(settings.compassDistanceMiles ?? 1);
  syncSliders();
  saveSettings(settings, 'transitlens-settings-v1');
}

/** Fullscreen (+ landscape lock for Cardboard). Must be kicked off synchronously from the tap. */
async function enterImmersive() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (!isMobileView()) await (screen.orientation as any).lock?.('landscape');
  } catch {
    // iPhone and desktop don't support these; the view still works.
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
  if (selectedFocusId !== lastFocusId) { lastFocusId = selectedFocusId; focusSinceMs = timeMs; }
  focusedBusId = selectedFocusId;
  const dwell = busFocus.progress(timeMs);
  mapState = { ...mapState, center: feedState?.position ?? null, responseCenter: feedState?.responseCenter ?? null, headingDeg };
  const routeId = routeSelection.update(buses.find(b => b.id === selectedFocusId) ?? null, timeMs);
  const route = routeId ? patterns?.get(routeId, timeMs) ?? null : null;
  streetMap?.update({ state: mapState, buses: allBuses, focusId: selectedFocusId, halfFov: lastHalfFovDeg, theme: currentTheme(), journey: journeyState, route });
  const hud = {
    headingDeg, halfTan, buses: buses,
    status: [feedState?.status ?? '', orientationMessage, orientation?.get()?.northReference === 'magnetic' ? 'Magnetic heading - true-north correction pending' : '', !DEV && headingDeg == null ? 'Compass unavailable - check motion permission' : ''].filter(Boolean).join(' · '),
    timeMs, voice: voiceHud, journey: journeyState, position: feedState?.position ?? null, assistantSource, demo: settings.dataMode === 'demo', handheld: isMobileView(),
    selectedFocusId, mapFrame: streetMap?.get(), expandedMap: mapState.mode === 'expanded',
    focusSinceMs, dwellId: dwell.id, dwellProgress: dwell.t, mobile: isMobileView(), theme: currentTheme(),
  };
  // Selection is already resolved. Every renderer receives the same state.
  for (const eye of view.eyes) drawHud(eye.ctx, width, height, hud);

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
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#b7d9d0';
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 2, 0, Math.PI * 2);
  ctx.fill();
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
  // Cardboard only: ask for landscape when portrait, or offer to re-enter fullscreen where it exists (not iPhone).
  const portrait = window.innerHeight > window.innerWidth;
  const resume = DEV || isMobileView() ? ''
    : portrait ? '<div class="hud-hint">Turn the phone sideways for Cardboard · long-press for settings</div>'
    : document.fullscreenEnabled && !document.fullscreenElement ? '<div class="hud-hint">Tap to go fullscreen · long-press for settings</div>' : '';
  const close = isMobileView() ? '<button class="view-close" data-exit aria-label="Back to settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : '';
  const toastHtml = toast ? `<div class="toast">${toast}</div>` : '';
  const calib = mode ? `<div class="calib">${modes().map((m) => `<span${m === mode ? ' class="on"' : ''}>${m}</span>`).join('')}</div>` : '';
  const expanded = mapState.mode === 'expanded';
  const icon = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const toggleIcon = expanded ? icon('M6 6l12 12M18 6L6 18') : icon('M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5');
  const controls = `<div class="map-controls${expanded ? ' is-expanded' : ''}"><button data-listen class="voice-trigger" data-state="${voiceHud.state}"><span class="voice-dot"></span>${voiceHud.state === 'idle' ? 'Hey Gemini' : voiceHud.state}</button><button data-assistant>Ask</button><button data-map="toggle" aria-pressed="${expanded}" aria-label="${expanded ? 'Close map' : 'Open map'}">${toggleIcon}</button><button data-map="in" aria-label="Zoom map in">${icon('M12 5v14M5 12h14')}</button><button data-map="out" aria-label="Zoom map out">${icon('M5 12h14')}</button></div>`;
  const credits = '<div class="map-credits" data-map-credit><a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></div>';
  const badge = `<div class="session-badge">${settings.dataMode === 'demo' ? (CAMERA_OFF ? 'DEMO · SYNTHETIC VEHICLES · NO CAMERA' : 'DEMO · SYNTHETIC VEHICLES') : 'LIVE RTS'} <span>TRANSITLENS</span></div>`;
  const html = `${badge}${credits}${mapState.mode === 'compact' ? '<div class="crosshair"></div>' : ''}${controls}${error}${resume}${close}${calib}${toastHtml}${debug}`;
  for (const eye of view.eyes) eye.overlay.innerHTML = html;
}

async function start() {
  if (startBtn.disabled) return;
  const activeSession = ++session;
  readSettingsFromForm();
  home?.stop();
  home = null;
  conversation.reset();
  focusedBusId = null;
  journeyState = createJourneyState();
  assistantSource = settings.dataMode === 'demo' ? 'DEMO DATA · awaiting command' : 'Ready · Gemini';
  renderJourneyOptions();
  voiceHud = { state: 'idle', transcript: null, answer: null, error: null, wakeEnabled: settings.voiceEnabled };
  assistantAnswer.textContent = '';
  updateAssistantFeedback('idle', null, null);
  // Initialize recognition and audio inside the Start gesture, before camera awaits.
  voice = startVoice({
    listenForWake: settings.voiceEnabled,
    followUpMs: settings.voiceEnabled ? 7000 : 0,
    onPartialTranscript: text => { voiceHud.transcript = text; updateAssistantFeedback(voiceHud.state, text, null); },
    onCaptureStart: () => conversation.capture(),
    requestAnswer: (question, signal) => {
      if (/read.*(?:sign|display)|scan.*bus|what.*(?:can you see|do you see)/i.test(question)) {
        const video = view?.eyes[0].video;
        if (!video?.videoWidth || !video.videoHeight) return Promise.resolve('The camera is not ready. Point the phone at the bus sign and try again.');
        const canvas = document.createElement('canvas');
        const scale = 640 / Math.max(video.videoWidth, video.videoHeight);
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d')!.drawImage(video,0,0,canvas.width,canvas.height);
        return conversation.ask(question, signal, { mimeType: 'image/jpeg', data: canvas.toDataURL('image/jpeg',0.65).split(',')[1] });
      }
      return conversation.ask(question, signal);
    },
    ttsEndpoint: null,
    onStateChange: state => { voiceHud.state = state; updateAssistantFeedback(state, voiceHud.transcript, voiceHud.error); renderOverlay(); },
    onTranscript: text => {
      clearTimeout(answerTimer);
      voiceHud = { ...voiceHud, transcript: text, answer: null, error: null };
      assistantAnswer.textContent = 'Thinking…';
      updateAssistantFeedback('thinking', text, null);
    },
    onAnswer: text => {
      voiceHud.answer = text;
      assistantAnswer.textContent = text;
      updateAssistantFeedback(voiceHud.state, voiceHud.transcript, null);
      answerTimer = window.setTimeout(() => { voiceHud.answer = null; voiceHud.transcript = null; }, 25000);
    },
    onError: message => {
      voiceHud.error = message.includes('not supported') ? 'Use Ask Gemini to type a question' : message;
      updateAssistantFeedback(voiceHud.state, voiceHud.transcript, voiceHud.error);
    },
  });
  // Both must start synchronously inside the tap (user-gesture requirements).
  const orientPermission = DEV ? Promise.resolve(true) : requestOrientationPermission();
  const immersive = DEV ? Promise.resolve() : enterImmersive();
  startBtn.disabled = true;
  startStatus.textContent = 'Starting camera…';

  try {
    hudError = '';
    if (CAMERA_OFF) { stream = null; hudError = settings.dataMode === 'demo' ? '' : 'Camera disabled - desktop blank background'; }
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
    lastFocusId = null;
    if (!DEV && settings.dataMode !== 'demo') gps = watchPosition();
    feed = settings.dataMode === 'demo' ? startDemoFeed() : startBusFeed({
      getPosition: () => DEV ? REITZ_CENTER : gps?.get() ?? null,
      positionStatus: () => DEV ? 'DESKTOP · fixed Reitz Union position' : gps?.status() ?? 'Waiting for GPS',
      radiusKm: settings.radiusKm ?? 5,
    });
    mapState = createMapState(settings.radiusKm ?? 5);
    patterns = settings.dataMode === 'demo'
      ? createPatternCache(async id => ({ pattern: demoPattern(id) }))
      : createPatternCache();
    routeSelection = createRouteSelection();
    streetMap = createStreetMap();
    view = isMobileView() ? createMonoView(stereoEl, stream) : createStereoView(stereoEl, stream);
    stereoEl.classList.toggle('is-mobile', isMobileView());
    if (DEV && settings.dataMode === 'demo') devHeading = feed.get().buses[0]?.bearingDeg ?? 0;
    mode = null;
    longPressFired = false;
    // Swallow the Android back gesture while in the view (see popstate handler).
    history.pushState({ arView: true }, '');
    startScreen.hidden = true;
    stereoEl.hidden = false;
    stereoEl.classList.toggle('demo-stage', CAMERA_OFF && settings.dataMode === 'demo');
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
  patterns?.stop();
  patterns = null;
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
  syncSliders();
  void renderPermissions(permList);
  restartHome();
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
  const list = modes();
  const i = mode ? list.indexOf(mode) + 1 : 0;
  mode = i < list.length ? list[i] : null;
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
  if ((e.target as Element).closest('[data-listen]') && settings.voiceEnabled) { voice?.listen(); return; }
  if ((e.target as Element).closest('[data-assistant], [data-listen]')) {
    conversation.capture();
    assistantPanel.showModal();
    questionInput.focus();
    return;
  }
  if ((e.target as Element).closest('[data-map-credit]')) return;
  if ((e.target as Element).closest('[data-exit]')) { stop(); return; }
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

compassAll.addEventListener('change', () => { compassInput.disabled = compassAll.checked; syncSliders(); });
for (const [input] of SLIDERS) input.addEventListener('input', syncSliders);
startBtn.addEventListener('click', start);
stereoEl.addEventListener('click', onViewTap);
// Long-press anywhere = back to the start screen (the deliberate way out).
stereoEl.addEventListener('pointerdown', (e) => {
  if ((e.target as Element).closest('[data-map], [data-map-credit], [data-exit], [data-assistant], [data-listen]')) return;
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
  if (!view && e.key === 'Escape') { closeSettings(); return; }
  if (view && e.code === 'Space') { e.preventDefault(); voice?.listen(); return; }
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
initDiscovery(async question => {
  if (startBtn.disabled && !view) return;
  if (!view) await start();
  if (!view || !voice) return;
  conversation.capture();
  assistantPanel.showModal();
  questionInput.focus();
  void voice.ask(question);
});

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

document.getElementById('demo-btn')!.addEventListener('click', () => { dataSelect.value = 'demo'; void start(); });
