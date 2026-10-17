import { Map, setWorkerUrl, setWorkerCount } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapPoint, mapZoom } from './map-state';
import type { MapState } from './map-state';
import type { Bus } from './buses';

setWorkerUrl(workerUrl);
setWorkerCount(1);
export type MapFrame = { canvas: HTMLCanvasElement; status: string; extentKm: number; northUp: boolean; mode: MapState['mode']; located: boolean };
type Input = { state: MapState; buses: Bus[]; focusId: string | null; halfFov: number };
const SIZE = 512;

/** Route badge centered on the bus position (map buffer pixels); selected = teal with a glow ring. */
function drawBusMarker(ctx: CanvasRenderingContext2D, x: number, y: number, route: string, focus: boolean, compact: boolean) {
  const font = (focus ? 36 : compact ? 30 : 22);
  ctx.font = `800 ${font}px system-ui, sans-serif`;
  const h = font + (compact ? 14 : 10);
  const w = Math.max(h, ctx.measureText(route).width + h * 0.7);
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
    ctx.fillStyle = 'rgba(140, 231, 219, 0.28)';
    ctx.beginPath(); ctx.arc(x, y, w / 2 + 14, 0, Math.PI * 2); ctx.fill();
  }
  path();
  ctx.fillStyle = focus ? '#8ce7db' : 'rgba(14, 19, 34, 0.92)';
  ctx.fill();
  ctx.lineWidth = focus ? 3 : 2.5;
  ctx.strokeStyle = focus ? '#f8fafc' : '#a7b8ff';
  ctx.stroke();
  ctx.fillStyle = focus ? '#0b1020' : '#f8fafc';
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
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#0e1322'; ctx.fillRect(0, 0, SIZE, SIZE);
    if (roads && map) ctx.drawImage(map.getCanvas(), 0, 0, SIZE, SIZE);
    else {
      ctx.strokeStyle = 'rgba(167, 184, 255, 0.2)'; ctx.lineWidth = 1;
      for (const r of [64, 128, 192, 255]) { ctx.beginPath(); ctx.arc(256, 256, r, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (state.center) {
      if (state.headingDeg !== null) {
        // View cone: lavender, fading out with distance.
        const cone = ctx.createRadialGradient(256, 256, 0, 256, 256, 180);
        cone.addColorStop(0, 'rgba(167, 184, 255, 0.45)'); cone.addColorStop(1, 'rgba(167, 184, 255, 0)');
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
        drawBusMarker(ctx, x, y, b.route, b === focused, compact);
      }
      // You: white dot with a teal ring.
      ctx.fillStyle = 'rgba(140, 231, 219, 0.25)';
      ctx.beginPath(); ctx.arc(256, 256, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f8fafc'; ctx.strokeStyle = '#8ce7db'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(256, 256, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    frame = { canvas, status: failed ? 'Road map unavailable - radar' : roads ? '' : 'Loading roads - radar', extentKm: state.extentKm, northUp: state.headingDeg === null, mode: state.mode, located: !!state.center };
  }
  function initialize() {
    if (map || failed || !input?.state.center) return;
    try {
      map = new Map({ container: host, style: 'https://tiles.openfreemap.org/styles/dark',
        center: [input.state.center.lon, input.state.center.lat], zoom: mapZoom(input.state, SIZE),
        interactive: false, attributionControl: false, pixelRatio: ratio,
        canvasContextAttributes: { preserveDrawingBuffer: true }, renderWorldCopies: false, fadeDuration: 0 });
      map.on('load', () => {
        if (!map) return;
        for (const layer of map.getStyle().layers) {
          if (layer.type === 'line' && /^(highway_|road_)/.test(layer.id) && !/casing|subtle/.test(layer.id)) map.setPaintProperty(layer.id, 'line-color', '#7b8b99');
          if (layer.type === 'symbol') {
            if (layer.layout?.['text-field']) {
              map.setLayoutProperty(layer.id, 'text-size', 28);
              map.setPaintProperty(layer.id, 'text-color', '#d3dce4');
              map.setPaintProperty(layer.id, 'text-halo-color', '#101820');
            }
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
