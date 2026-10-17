// Home screen: live RTS indicator and a rail of nearby-bus cards.
// Reuses the AR bus feed and GPS watcher, so the same server-side Live RTS policy applies:
// no demo vehicles, failures keep the last good data, unknown fields stay unknown.
// Location is only requested from a tap (or automatically when already granted).

import { REITZ_CENTER, startBusFeed, watchPosition } from './buses';
import type { Bus, BusFeed, Position } from './buses';
import { busFields } from './format';
import { normalizeDeg } from './geo';

const MAX_CARDS = 8;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cardinal = (deg: number) => CARDINALS[Math.round(normalizeDeg(deg) / 45) % 8];

type LiveState = 'connecting' | 'live' | 'unavailable';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function chip(text: string | null, unknownText: string, cls = ''): HTMLElement {
  return text == null ? el('span', 'chip unknown', unknownText) : el('span', `chip ${cls}`.trim(), text);
}

function busCardEl(b: Bus): HTMLElement {
  const f = busFields(b);
  const card = el('article', 'bus-card');
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', `Route ${b.route}${b.destination ? ` to ${b.destination}` : ''}, ${f.distance} ${cardinal(b.bearingDeg)}`);

  const top = el('div', 'bus-card-top');
  top.append(el('span', 'route-chip', b.route));
  const dist = el('div', 'bus-dist');
  dist.append(el('b', undefined, f.distance), el('span', undefined, `${cardinal(b.bearingDeg)} of you`));
  top.append(dist);

  const dest = el('p', b.destination ? 'bus-dest' : 'bus-dest unknown', b.destination ?? 'Destination unknown');

  const chips = el('div', 'chips');
  chips.append(
    chip(f.speed, 'Speed unknown'),
    chip(f.delay, 'Delay unknown', b.delayed ? 'delayed' : 'ontime'),
    chip(f.load, 'Load unknown'),
  );
  card.append(top, dest, chips);
  return card;
}

export function startHome(opts: { dev: boolean; radiusKm: () => number }) {
  const pill = document.getElementById('live-pill')!;
  const pillText = pill.querySelector<HTMLElement>('.live-text')!;
  const body = document.getElementById('nearby')!;
  const rail = document.getElementById('bus-rail')!;
  const meta = document.getElementById('nearby-meta')!;
  const emptyTitle = body.querySelector<HTMLElement>('.empty-title')!;
  const emptyText = body.querySelector<HTMLElement>('.empty-text')!;
  const locate = document.getElementById('nearby-locate') as HTMLButtonElement;
  const greeting = document.getElementById('greeting')!;

  const hour = new Date().getHours();
  greeting.textContent = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  let gps: ReturnType<typeof watchPosition> | null = null;
  let feed: BusFeed | null = null;
  let probe: BusFeed | null = null;
  let timer = 0;
  let lastKey = '';

  const position = (): Position | null => (opts.dev ? REITZ_CENTER : gps?.get() ?? null);

  function startFeed() {
    probe?.stop();
    probe = null;
    feed?.stop();
    feed = startBusFeed({
      getPosition: position,
      positionStatus: () => (opts.dev ? '' : gps?.status() ?? ''),
      radiusKm: opts.radiusKm(),
    });
  }

  function useLocation() {
    if (!opts.dev && !gps) gps = watchPosition();
    body.dataset.state = 'locating';
    startFeed();
  }
  locate.addEventListener('click', useLocation);

  function setLive(state: LiveState, text: string) {
    pill.dataset.state = state;
    pillText.textContent = text;
  }

  function render() {
    const active = feed ?? probe;
    const s = active?.get();
    const status = s?.status ?? '';
    const unavailable = /UNAVAILABLE/.test(status);
    const answered = unavailable || /Live RTS|No nearby buses/.test(status);
    setLive(unavailable ? 'unavailable' : answered ? 'live' : 'connecting', unavailable ? 'RTS unavailable' : answered ? 'Live RTS' : 'Connecting');
    if (!feed) return;

    const pos = position();
    const gpsStatus = gps?.status() ?? '';
    const buses = pos && s ? [...s.buses].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, MAX_CARDS) : [];
    const age = /data (\d+)s old/.exec(status)?.[1];

    if (buses.length) {
      body.dataset.state = 'buses';
      meta.textContent = `${opts.dev ? 'Near Reitz Union · ' : ''}${unavailable ? 'Last known' : 'Live'}${age ? ` · ${age}s ago` : ''}`;
      // Rebuild only when the set or values change, so scrolling isn't interrupted.
      const key = JSON.stringify(buses.map((b) => [b.id, b.route, b.destination, b.speedMph, b.delayed, b.passengerLoad, Math.round(b.distanceKm * 100), Math.round(b.bearingDeg / 10)]));
      if (key !== lastKey) {
        lastKey = key;
        rail.replaceChildren(...buses.map(busCardEl));
      }
      return;
    }
    lastKey = '';
    meta.textContent = '';
    if (!pos) {
      body.dataset.state = /denied/i.test(gpsStatus) ? 'idle' : 'locating';
      emptyTitle.textContent = /denied/i.test(gpsStatus) ? 'Location is off' : 'Finding your location…';
      emptyText.textContent = /denied/i.test(gpsStatus) ? 'Allow location for this site in your browser settings, then try again.' : gpsStatus || 'This takes a few seconds outdoors.';
    } else if (unavailable) {
      body.dataset.state = 'unavailable';
      emptyTitle.textContent = 'Live data temporarily unavailable';
      emptyText.textContent = 'RTS isn’t responding right now. Buses appear here as soon as it’s back.';
    } else if (answered) {
      body.dataset.state = 'empty';
      emptyTitle.textContent = 'No nearby buses';
      emptyText.textContent = `No RTS buses are reporting within ${opts.radiusKm()} km right now.`;
    } else {
      body.dataset.state = 'locating';
      emptyTitle.textContent = 'Loading live buses…';
      emptyText.textContent = 'Connecting to Live RTS.';
    }
  }

  async function begin() {
    if (opts.dev) return useLocation();
    // Without location, still show whether Live RTS is reachable (any point works; the service caches city-wide).
    probe = startBusFeed({ getPosition: () => REITZ_CENTER, positionStatus: () => '', radiusKm: 1 });
    try {
      const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
      if (status?.state === 'granted') useLocation();
    } catch {
      // Not queryable: wait for the button.
    }
  }

  void begin();
  timer = window.setInterval(render, 1000);
  render();

  return {
    /** Stops polling and GPS (entering AR starts its own). */
    stop() {
      clearInterval(timer);
      feed?.stop();
      probe?.stop();
      gps?.stop();
      feed = probe = null;
      gps = null;
    },
  };
}
