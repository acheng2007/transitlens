import { Map, setWorkerUrl, setWorkerCount } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapPoint, mapZoom } from './map-state';
import type { MapState } from './map-state';
import type { Bus } from './buses';
import type { JourneyState } from './journey-state';
import type { GeoPoint } from '../../shared/journey';

setWorkerUrl(workerUrl);
setWorkerCount(1);
export type MapFrame = { canvas: HTMLCanvasElement; status: string; extentKm: number; northUp: boolean; mode: MapState['mode']; located: boolean };
type Input = { state: MapState; buses: Bus[]; focusId: string | null; halfFov: number; journey?: JourneyState };
const SIZE = 512;
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
    ctx.fillStyle = '#0c1922'; ctx.fillRect(0, 0, SIZE, SIZE);
    if (roads && map) ctx.drawImage(map.getCanvas(), 0, 0, SIZE, SIZE);
    else {
      ctx.strokeStyle = '#284351'; ctx.lineWidth = 1;
      for (const r of [64, 128, 192, 255]) { ctx.beginPath(); ctx.arc(256, 256, r, 0, Math.PI * 2); ctx.stroke(); }
    }
    const project = (p: GeoPoint): [number, number] => {
      const point = roads && map ? map.project([p.lon, p.lat]) : null;
      return point ? [point.x, point.y] : mapPoint(p, state, SIZE);
    };
    // Paths are authoritative RTS shapes. No LLM coordinates enter the renderer.
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, SIZE, SIZE); ctx.clip();
    for (const route of input.journey?.routes ?? []) {
      ctx.strokeStyle = route.color; ctx.lineWidth = state.mode === 'expanded' ? 5 : 8;
      ctx.shadowColor = route.color; ctx.shadowBlur = 10; ctx.beginPath();
      route.shape.forEach((p, i) => { const [x,y] = project(p); if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y); });
      ctx.stroke(); ctx.shadowBlur = 0;
      ctx.strokeStyle = '#bbfff1'; ctx.lineWidth = 1.5; ctx.stroke();
      for (const stop of route.stops) {
        const [x,y] = project(stop); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill();
      }
    }
    const trip = input.journey?.guidance;
    if (trip) {
      for (const [stop, color, name] of [[trip.boardingStop, '#b5ff67', 'BOARD'], [trip.alightingStop, '#ffc94d', 'DESTINATION']] as const) {
        const [x,y] = project(stop);
        ctx.fillStyle = color; ctx.strokeStyle = '#08121c'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(x,y,12,0,Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.font = 'bold 18px system-ui'; ctx.textAlign = 'center'; ctx.fillText(name,x,y-18);
      }
      // Dashed line is explicitly a bearing cue, never a pedestrian route.
      const [x,y] = project(trip.boardingStop);
      ctx.setLineDash([7,7]); ctx.strokeStyle='#b5ff6788'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(256,256); ctx.lineTo(x,y); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    if (state.center) {
      if (state.headingDeg !== null) {
        ctx.fillStyle = '#4fc3f733'; ctx.beginPath(); ctx.moveTo(256, 256);
        const half = halfFov * Math.PI / 180;
        ctx.arc(256, 256, 160, -Math.PI / 2 - half, -Math.PI / 2 + half); ctx.closePath(); ctx.fill();
      }
      for (const b of buses) {
        const point = roads && map ? map.project([b.lon, b.lat]) : null;
        const [x, y] = point ? [point.x, point.y] : mapPoint(b, state, SIZE);
        if (x < 0 || y < 0 || x > SIZE || y > SIZE) continue;
        const relevant = !input.journey?.routes.length || input.journey.routes.some(r => r.routeId === b.route);
        ctx.globalAlpha = relevant || b.id === focusId ? 1 : 0.35;
        ctx.fillStyle = b.id === focusId ? '#ffc94d' : input.journey?.routes.some(r => r.routeId === b.route) ? '#b5ff67' : '#67dcff';
        ctx.strokeStyle = '#08121c'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, b.id === focusId ? 14 : state.mode === 'compact' ? 10 : 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.font = `bold ${state.mode === 'compact' ? 32 : 24}px system-ui`; ctx.textAlign = 'center'; if (relevant || state.mode === 'compact' || b.id === focusId) ctx.fillText(b.route, x, y - (state.mode === 'compact' ? 18 : 14));
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#159cd0'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(256, 256, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
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
