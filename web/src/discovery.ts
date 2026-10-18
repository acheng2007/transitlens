import { DEMO_PATTERNS } from './demo';
import type { RouteOverlay, GeoPoint } from '../../shared/journey';
import type { JourneyState } from './journey-state';
import { arrivalLabel } from './journey-state';
import { mercatorPoint } from './map-state';
import type { VoiceState } from './voice/types';

const SVG = 'http://www.w3.org/2000/svg';

/** Fit captured geometry into a schematic, preserving aspect and stop positions. */
export function previewProjection(route: RouteOverlay) {
  const points = route.shape.map(mercatorPoint);
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(360 / Math.max(maxX - minX, 1e-8), 190 / Math.max(maxY - minY, 1e-8));
  return (point: GeoPoint): [number, number] => {
    const [x, y] = mercatorPoint(point);
    return [240 + (x - (minX + maxX) / 2) * scale, 130 + (y - (minY + maxY) / 2) * scale];
  };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Home-only illustration and entry points; all actions use the real copilot pipeline. */
export function initDiscovery(launch: (question: string) => Promise<void>) {
  const svg = document.getElementById('route-preview')!;
  const tabs = document.getElementById('preview-route-tabs')!;
  const routeName = document.getElementById('preview-route-name')!;
  const routes = ['9', '20', '38'].map(id => DEMO_PATTERNS.find(p => p.routeId === id)!).filter(Boolean);
  function draw(route: RouteOverlay) {
    const project = previewProjection(route);
    svg.replaceChildren();
    const title = document.createElementNS(SVG, 'title');
    title.textContent = `Captured route ${route.routeId}: ${route.name}, ${route.stops.length} stops. Illustrative marker, not a live bus.`;
    svg.setAttribute('aria-label', title.textContent);
    svg.append(title);
    for (const path of DEMO_PATTERNS) {
      const line = document.createElementNS(SVG, 'polyline');
      line.setAttribute('points', path.shape.map(p => project(p).join(',')).join(' '));
      line.setAttribute('class', path.id === route.id ? 'preview-line selected' : 'preview-line');
      svg.append(line);
    }
    // Preserve endpoints while thinning dense stop dots at the schematic scale.
    let last: [number, number] | null = null;
    for (const [i, stop] of route.stops.entries()) {
      const [x, y] = project(stop);
      if (last && i < route.stops.length - 1 && Math.hypot(x - last[0], y - last[1]) < 13) continue;
      last = [x, y];
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y)); dot.setAttribute('r', '3.5');
      dot.setAttribute('class', 'preview-stop'); svg.append(dot);
    }
    const [x, y] = project(route.shape[Math.floor(route.shape.length * 0.42)]);
    const marker = document.createElementNS(SVG, 'g');
    marker.setAttribute('transform', `translate(${x},${y})`);
    const ring = document.createElementNS(SVG, 'circle'); ring.setAttribute('r', '20'); ring.setAttribute('class', 'preview-halo');
    const disk = document.createElementNS(SVG, 'circle'); disk.setAttribute('r', '13'); disk.setAttribute('class', 'preview-vehicle');
    const label = document.createElementNS(SVG, 'text'); label.textContent = route.routeId; label.setAttribute('class', 'preview-vehicle-label');
    marker.append(ring, disk, label); svg.append(marker);
    routeName.textContent = `${route.name} · ${route.stops.length} stops`;
    for (const button of tabs.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.route === route.routeId));
  }
  for (const route of routes) {
    const button = element('button', '', route.routeId);
    button.type = 'button'; button.dataset.route = route.routeId;
    button.setAttribute('aria-label', `Preview captured route ${route.routeId}`);
    button.addEventListener('click', () => draw(route)); tabs.append(button);
  }
  if (routes.length) draw(routes.at(-1)!);

  const form = document.getElementById('home-question-form') as HTMLFormElement;
  const input = document.getElementById('home-question') as HTMLInputElement;
  let launching = false;
  async function open(question: string) {
    if (launching || !question.trim()) return;
    launching = true;
    form.setAttribute('aria-busy', 'true');
    const buttons = document.querySelectorAll<HTMLButtonElement>('#home-question-form button, [data-launch-question]');
    buttons.forEach(b => { b.disabled = true; });
    try { await launch(question.trim()); }
    finally { launching = false; form.setAttribute('aria-busy', 'false'); buttons.forEach(b => { b.disabled = false; }); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void open(input.value); });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-launch-question]')) {
    button.addEventListener('click', () => { void open(button.dataset.launchQuestion!); });
  }
}

/** A configured key is distinct from a successful provider request. */
export function updateCopilotConnection(configured: boolean | null) {
  const status = document.getElementById('home-copilot-status')!;
  status.textContent = configured === null ? 'Service offline' : configured ? 'Gemini configured' : 'Local commands';
  status.dataset.state = configured === null ? 'offline' : configured ? 'configured' : 'local';
  document.getElementById('home-copilot-note')!.textContent = configured === null
    ? 'Copilot service is unavailable. You can still explore buses in your selected view.'
    : configured ? 'Opens your selected view. Ask by voice or type a question.'
    : 'Local route and map commands are ready. Open-ended questions need Gemini.';
}

/** Rich trip cards render authoritative values without inventing arrival or walking times. */
export function renderTripChoices(host: HTMLElement, state: JourneyState, select: (id: string) => void, clarify: (stopId: string) => void) {
  host.replaceChildren();
  const plan = state.plan;
  if (!plan) return;
  const heading = element('div', 'trip-results-heading');
  heading.append(element('span', 'micro-label', plan.status === 'ambiguous' ? 'CHOOSE A DESTINATION' : 'DIRECT TRIPS'));
  if (plan.options.length) heading.append(element('span', '', `${plan.options.length} ${plan.options.length === 1 ? 'option' : 'options'}`));
  host.append(heading);
  for (const [i, option] of plan.options.entries()) {
    const selected = state.selectedJourneyId === option.id;
    const button = element('button', 'trip-choice'); button.type = 'button';
    button.style.setProperty('--trip-color', option.color);
    button.setAttribute('aria-pressed', String(selected));
    const top = element('div', 'trip-choice-top');
    const badge = element('span', 'trip-route-badge', option.routeId);
    const name = element('span', 'trip-choice-name');
    name.append(element('strong', '', option.routeName), element('span', '', option.direction));
    top.append(badge, name, element('span', 'trip-choice-index', `${String(i + 1).padStart(2, '0')} ↗`));
    const stops = element('div', 'trip-stop-list');
    for (const [label, stop] of [['BOARD', option.boardingStop], ['GET OFF', option.alightingStop]] as const) {
      const row = element('div', 'trip-stop'); row.append(element('span', '', label), element('strong', '', stop.name)); stops.append(row);
    }
    const meta = element('div', 'trip-choice-meta');
    meta.append(element('span', '', option.onboard ? 'Already onboard' : `${Math.round(option.walkKm * 1000)} m straight-line to stop`), element('span', '', `${option.rideStops} stops`), element('span', 'trip-arrival', arrivalLabel(option)));
    if (option.vehicles?.length) meta.append(element('span', '', `Vehicles ${option.vehicles.map(vehicle => vehicle.busId).join(', ')}`));
    const action = element('span', 'trip-choice-action', state.guidance?.id === option.id ? 'Selected · boarding guidance on map' : selected ? 'Chosen trip · show boarding stop' : 'Choose trip & show boarding stop');
    button.append(top, stops, meta, action);
    button.addEventListener('click', () => select(option.id));
    host.append(button);
  }
  if (plan.options.length) host.append(element('p', 'trip-results-note', 'Distance to the stop is straight-line. Transfers and pedestrian routes are not included.'));
  if (plan.status === 'ambiguous') {
    host.append(element('p', 'trip-results-note', 'Several stops match. Choose the place you mean.'));
    for (const stop of plan.destinations) {
      const button = element('button', 'destination-choice'); button.type = 'button';
      button.append(element('strong', '', stop.name), element('span', '', `RTS stop ${stop.id} ↗`));
      button.addEventListener('click', () => clarify(stop.id)); host.append(button);
    }
  }
  if (plan.networkStatus !== 'available') host.append(element('p', 'trip-results-note', `Route catalog: ${plan.networkStatus}. Coverage may be incomplete.`));
}

export function updateAssistantFeedback(state: VoiceState, transcript: string | null, error: string | null) {
  const panel = document.getElementById('assistant-panel')!;
  panel.dataset.state = state;
  const feedback = panel.querySelector<HTMLElement>('.assistant-feedback')!;
  feedback.dataset.state = error ? 'error' : state;
  const labels = { idle: 'Ask about a bus, route, or destination', listening: 'Listening to your question…', thinking: 'Checking transit context…', speaking: 'Speaking · say Hey Gemini to ask again' };
  document.getElementById('assistant-activity-label')!.textContent = error ?? labels[state];
  const echo = document.getElementById('assistant-question-echo')!;
  echo.hidden = !transcript; echo.textContent = transcript ? `“${transcript}”` : '';
  const form = document.getElementById('assistant-form')!;
  form.setAttribute('aria-busy', String(state === 'thinking'));
  for (const button of panel.querySelectorAll<HTMLButtonElement>('.assistant-prompts button, #assistant-form button')) button.disabled = state === 'thinking';
}
