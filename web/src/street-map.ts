import { Map, setWorkerUrl, setWorkerCount } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapPoint, mapZoom, mapBufferSize } from './map-state';
import type { MapState } from './map-state';
import type { Bus } from './buses';
import type { JourneyState } from './journey-state';
import type { GeoPoint } from '../../shared/journey';
import type { TransitPattern } from '../../shared/transit';
import { drawRoutePattern } from './route-overlay';

setWorkerUrl(workerUrl);
setWorkerCount(1);
export type MapFrame = { canvas: HTMLCanvasElement; baseCanvas: HTMLCanvasElement; overlayCanvas: HTMLCanvasElement; status: string; extentKm: number; northUp: boolean; mode: MapState['mode']; located: boolean };
type Theme = 'light' | 'dark';
type Input = { aspect?: number; state: MapState; buses: Bus[]; focusId: string | null; halfFov: number; theme?: Theme; journey?: JourneyState; route?: TransitPattern | null };


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
  const baseCanvas = document.createElement('canvas');
  const overlayCanvas = document.createElement('canvas');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  let width = 512, height = 512;
  for (const layer of [canvas, baseCanvas, overlayCanvas]) layer.width = layer.height = 512 * ratio;
  const ctx = overlayCanvas.getContext('2d')!;
  const base = baseCanvas.getContext('2d')!;
  const composite = canvas.getContext('2d')!;
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
    const { state, buses, focusId, halfFov, route } = input;
    const theme: Theme = input.theme ?? 'light';
    const c = MAP_COLORS[theme];
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    base.setTransform(ratio, 0, 0, ratio, 0, 0);
    base.clearRect(0, 0, width, height);
    base.fillStyle = c.fallbackBg; base.fillRect(0, 0, width, height);
    if (roads && map) base.drawImage(map.getCanvas(), 0, 0, width, height);
    else {
      base.strokeStyle = c.fallbackRing; base.lineWidth = 1;
      for (const r of [64, 128, 192, 255]) { base.beginPath(); base.arc(width / 2, height / 2, r, 0, Math.PI * 2); base.stroke(); }
    }
    const project = (p: GeoPoint): [number, number] => {
      const point = roads && map ? map.project([p.lon, p.lat]) : null;
      return point ? [point.x, point.y] : mapPoint(p, state, width, height);
    };
    // Paths are authoritative RTS shapes. No LLM coordinates enter the renderer.
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
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
      if (!trip.onboard) {
        const [x,y] = project(trip.boardingStop);
        ctx.setLineDash([7,7]); ctx.strokeStyle='#b5ff6788'; ctx.lineWidth=3;
        ctx.beginPath(); ctx.moveTo(width / 2,height / 2); ctx.lineTo(x,y); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    const busStop = input.journey?.busStop;
    for (const stop of busStop?.stop ? [busStop.stop] : busStop?.stops ?? []) {
      const [x,y] = project(stop);
      ctx.fillStyle = '#ffc94d'; ctx.strokeStyle = '#08121c'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x,y,11,0,Math.PI*2); ctx.fill(); ctx.stroke();
      ctx.font = 'bold 18px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(`STOP ${stop.id}`,x,y-18);
    }
    ctx.restore();
    if (state.center) {
      if (state.headingDeg !== null) {
        // View cone, fading out with distance.
        const cone = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, 180);
        cone.addColorStop(0, `rgba(${c.cone}, ${c.coneAlpha})`); cone.addColorStop(1, `rgba(${c.cone}, 0)`);
        ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(width / 2, height / 2);
        const half = halfFov * Math.PI / 180;
        ctx.arc(width / 2, height / 2, 180, -Math.PI / 2 - half, -Math.PI / 2 + half); ctx.closePath(); ctx.fill();
      }
      const projectLatLon = (lat: number, lon: number): [number, number] => project({ lat, lon });
      if (route && !(input.journey?.routes.length)) drawRoutePattern(ctx, route, projectLatLon, state.mode === 'compact');
      const compact = state.mode === 'compact';
      const queryBuses: Bus[] = (busStop?.vehicles ?? []).filter(v=>!buses.some(b=>b.id===v.busId)).map(v=>({
        id:v.busId,route:v.routeId,lat:v.lat,lon:v.lon,destination:v.destination,patternId:v.patternId,
        headingDeg:null,speedMph:null,delayed:null,passengerLoad:null,distanceKm:0,bearingDeg:0,
      }));
      const visible = [...buses, ...queryBuses];
      const selectedId = busStop?.busId ?? (busStop?.vehicles.length === 1 ? busStop.vehicles[0].busId : focusId);
      const focused = visible.find(b => b.id === selectedId);
      // Selected bus last so its badge sits on top.
      for (const b of [...visible.filter(b => b !== focused), ...(focused ? [focused] : [])]) {
        const [x, y] = project(b);
        if (x < 0 || y < 0 || x > width || y > height) continue;
        const relevant = !input.journey?.routes.length || input.journey.routes.some(r => r.routeId === b.route);
        ctx.globalAlpha = relevant || b.id === focusId ? 1 : 0.35;
        drawBusMarker(ctx, x, y, b.route, b === focused, compact, theme);
      }
      ctx.globalAlpha = 1;
      // You: solid dot with a contrasting ring and an accent halo.
      ctx.fillStyle = 'rgba(183, 217, 208, 0.5)';
      ctx.beginPath(); ctx.arc(width / 2, height / 2, 20, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.you; ctx.strokeStyle = c.youRing; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(width / 2, height / 2, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    composite.clearRect(0, 0, canvas.width, canvas.height);
    composite.drawImage(baseCanvas, 0, 0);
    composite.drawImage(overlayCanvas, 0, 0);
    frame = { canvas, baseCanvas, overlayCanvas, status: failed ? 'Road map unavailable - radar' : roads ? '' : 'Loading roads - radar', extentKm: state.extentKm, northUp: state.headingDeg === null, mode: state.mode, located: !!state.center };
  }
  function initialize() {
    if (map || failed || !input?.state.center) return;
    try {
      // Light theme: OpenFreeMap "positron" (light streets); dark theme: OpenFreeMap "dark". Fixed per session.
      const dark = input.theme === 'dark';
      map = new Map({ container: host, style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
        center: [input.state.center.lon, input.state.center.lat], zoom: mapZoom(input.state, Math.min(width, height)),
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
        map.jumpTo({ center: [state.center.lon, state.center.lat], bearing: state.headingDeg ?? 0, zoom: mapZoom(state, Math.min(width, height)) });
        // Capture only after rendering, so streets and projected markers match.
        map.triggerRepaint();
      } else if (ready && !failed && map.areTilesLoaded()) capture(true);
    }
    if (!ready || failed || !state.center) capture(false);
  }, Math.ceil(1000 / 15));
  return {
    update(next: Input) {
      input = next;
      const size = mapBufferSize(next.aspect ?? 1);
      if (width === size.width && height === size.height) return;
      width = size.width; height = size.height;
      host.style.width = `${width}px`; host.style.height = `${height}px`;
      for (const layer of [canvas, baseCanvas, overlayCanvas]) { layer.width = width * ratio; layer.height = height * ratio; }
      frame = null; lastCamera = ''; ready = false;
      map?.resize();
      capture(false);
    },
    get: () => frame && input ? { ...frame, mode: input.state.mode } : frame,
    stop() { stopped = true; clearInterval(timer); map?.getCanvas().removeEventListener('webglcontextlost', lost); map?.remove(); map = null; host.remove(); frame = null; },
  };
}
