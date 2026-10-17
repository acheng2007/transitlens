import { Map, setWorkerUrl, setWorkerCount } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapPoint, mapZoom } from './map-state';
import type { MapState } from './map-state';
import type { Bus } from './buses';

setWorkerUrl(workerUrl);
setWorkerCount(1);
export type MapFrame = { canvas: HTMLCanvasElement; status: string; extentKm: number; northUp: boolean; mode: MapState['mode']; located: boolean };
type Theme = 'light' | 'dark';
type Input = { state: MapState; buses: Bus[]; focusId: string | null; halfFov: number; theme?: Theme };
const SIZE = 512;

/** Map overlay colors per theme (mirror the HUD palettes in hud.ts). */
const MAP_COLORS = {
  light: {
    fallbackBg: '#eef0ef', fallbackRing: 'rgba(17, 17, 17, 0.12)', cone: '17, 17, 17', coneAlpha: 0.22,
    pill: '#ffffff', pillText: '#111111', pillBorder: 'rgba(17, 17, 17, 0.28)',
    you: '#111111', youRing: '#ffffff',
  },
  dark: {
    fallbackBg: '#17181a', fallbackRing: 'rgba(255, 255, 255, 0.14)', cone: '255, 255, 255', coneAlpha: 0.3,
    pill: 'rgba(24, 25, 27, 0.95)', pillText: '#f5f5f3', pillBorder: 'rgba(255, 255, 255, 0.4)',
    you: '#f5f5f3', youRing: '#111111',
  },
};
const ACCENT = '#b7d9d0';

/** Route label centered on the bus position (map buffer pixels); selected = accent with a soft halo. */
function drawBusMarker(ctx: CanvasRenderingContext2D, x: number, y: number, route: string, focus: boolean, compact: boolean, theme: Theme) {
  const c = MAP_COLORS[theme];
  const font = focus ? 36 : compact ? 30 : 22;
  ctx.font = `800 ${font}px system-ui, -apple-system, sans-serif`;
  const h = font + (compact ? 16 : 12);
  const w = Math.max(h, ctx.measureText(route).width + h * 0.75);
  const r = h / 2;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x - w / 2 + r, y - h / 2);
    ctx.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, r);
    ctx.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, r);
    ctx.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, r);
    ctx.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, r);
    ctx.closePath();
  };
  if (focus) {
    ctx.fillStyle = 'rgba(183, 217, 208, 0.45)';
    ctx.beginPath(); ctx.arc(x, y, w / 2 + 16, 0, Math.PI * 2); ctx.fill();
  }
  path();
  ctx.fillStyle = focus ? ACCENT : c.pill;
  ctx.fill();
  ctx.lineWidth = focus ? 3 : 2.5;
  ctx.strokeStyle = focus ? '#111111' : c.pillBorder;
  ctx.stroke();
  ctx.fillStyle = focus ? '#111111' : c.pillText;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(route, x, y + 1);
}

/** One asynchronous renderer and shared composite frame shared by every output. */
export function createStreetMap() {
  const host = document.createElement('div');
  host.className = 'map-buffer';
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  const canvas = document.createElement('canvas');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.height = SIZE * ratio;
  const ctx = canvas.getContext('2d')!;
  let map: Map | null = null;
  let input: Input | null = null;
  let failed = false;
  let ready = false;
  let stopped = false;
  let lastCamera = '';
  let frame: MapFrame | null = null;
  let lastCapture = 0;
  function capture(roads: boolean) {
    if (!input || stopped) return;
    const { state, buses, focusId, halfFov } = input;
    const theme: Theme = input.theme ?? 'light';
    const c = MAP_COLORS[theme];
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = c.fallbackBg; ctx.fillRect(0, 0, SIZE, SIZE);
    if (roads && map) ctx.drawImage(map.getCanvas(), 0, 0, SIZE, SIZE);
    else {
      ctx.strokeStyle = c.fallbackRing; ctx.lineWidth = 1;
      for (const r of [64, 128, 192, 255]) { ctx.beginPath(); ctx.arc(256, 256, r, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (state.center) {
      if (state.headingDeg !== null) {
        // View cone, fading out with distance.
        const cone = ctx.createRadialGradient(256, 256, 0, 256, 256, 180);
        cone.addColorStop(0, `rgba(${c.cone}, ${c.coneAlpha})`); cone.addColorStop(1, `rgba(${c.cone}, 0)`);
        ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(256, 256);
        const half = halfFov * Math.PI / 180;
        ctx.arc(256, 256, 180, -Math.PI / 2 - half, -Math.PI / 2 + half); ctx.closePath(); ctx.fill();
      }
      const compact = state.mode === 'compact';
      const focused = buses.find(b => b.id === focusId);
      // Selected bus last so its badge sits on top.
      for (const b of [...buses.filter(b => b !== focused), ...(focused ? [focused] : [])]) {
        const point = roads && map ? map.project([b.lon, b.lat]) : null;
        const [x, y] = point ? [point.x, point.y] : mapPoint(b, state, SIZE);
        if (x < 0 || y < 0 || x > SIZE || y > SIZE) continue;
        drawBusMarker(ctx, x, y, b.route, b === focused, compact, theme);
      }
      // You: solid dot with a contrasting ring and an accent halo.
      ctx.fillStyle = 'rgba(183, 217, 208, 0.5)';
      ctx.beginPath(); ctx.arc(256, 256, 20, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.you; ctx.strokeStyle = c.youRing; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(256, 256, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    frame = { canvas, status: failed ? 'Road map unavailable - radar' : roads ? '' : 'Loading roads - radar', extentKm: state.extentKm, northUp: state.headingDeg === null, mode: state.mode, located: !!state.center };
  }
  function initialize() {
    if (map || failed || !input?.state.center) return;
    try {
      // Light theme: OpenFreeMap "positron" (light streets); dark theme: OpenFreeMap "dark". Fixed per session.
      const dark = input.theme === 'dark';
      map = new Map({ container: host, style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
        center: [input.state.center.lon, input.state.center.lat], zoom: mapZoom(input.state, SIZE),
        interactive: false, attributionControl: false, pixelRatio: ratio,
        canvasContextAttributes: { preserveDrawingBuffer: true }, renderWorldCopies: false, fadeDuration: 0 });
      map.on('load', () => {
        if (!map) return;
        for (const layer of map.getStyle().layers) {
          // Brighter roads on the dark style; positron's roads already read well.
          if (dark && layer.type === 'line' && /^(highway_|road_)/.test(layer.id) && !/casing|subtle/.test(layer.id)) map.setPaintProperty(layer.id, 'line-color', '#7b8b99');
          if (layer.type === 'symbol' && layer.layout?.['text-field']) {
            // The 512 px buffer is drawn small in each eye: enlarge place names so they stay legible.
            map.setLayoutProperty(layer.id, 'text-size', 28);
            map.setPaintProperty(layer.id, 'text-color', dark ? '#d3dce4' : '#3a3a3a');
            map.setPaintProperty(layer.id, 'text-halo-color', dark ? '#101820' : '#ffffff');
          }
        }
      });
      map.on('error', () => { failed = true; capture(false); });
      map.on('idle', () => { if (!failed) { ready = true; capture(true); } });
      map.on('render', () => {
        if (ready && !failed && map?.areTilesLoaded() && performance.now() - lastCapture >= 1000 / 15) { lastCapture = performance.now(); capture(true); }
      });
      map.getCanvas().addEventListener('webglcontextlost', lost);
    } catch { failed = true; map?.remove(); map = null; }
  }
  function lost() { failed = true; ready = false; capture(false); }
  const timer = window.setInterval(() => {
    if (!input) return;
    initialize();
    const { state } = input;
    if (map && state.center) {
      const camera = JSON.stringify([state.center, state.headingDeg, state.extentKm]);
      if (camera !== lastCamera) {
        lastCamera = camera;
        map.jumpTo({ center: [state.center.lon, state.center.lat], bearing: state.headingDeg ?? 0, zoom: mapZoom(state, SIZE) });
        // Capture only after rendering, so streets and projected markers match.
        map.triggerRepaint();
      } else if (ready && !failed && map.areTilesLoaded()) capture(true);
    }
    if (!ready || failed || !state.center) capture(false);
  }, Math.ceil(1000 / 15));
  return {
    update(next: Input) { input = next; },
    get: () => frame && input ? { ...frame, mode: input.state.mode } : frame,
    stop() { stopped = true; clearInterval(timer); map?.getCanvas().removeEventListener('webglcontextlost', lost); map?.remove(); map = null; host.remove(); frame = null; },
  };
}
