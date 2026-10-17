// Desktop test harness for the voice module. Open http://localhost:5173/src/voice/dev.html
// with `npm run dev` running in web/. Not part of the app.

import { startVoice } from './index';
import type { Plane, Recognizer, VoiceHandle, VoiceState } from './types';

const SAMPLE_PLANES: Plane[] = [
  { id: 'a4f2c1', callsign: 'DAL1234', registration: 'N301DN', typeCode: 'A321', typeName: 'Airbus A321-200', airline: 'Delta Air Lines', origin: 'LGA', destination: 'ATL', lat: 33.7, lon: -84.4, altitudeFt: 4200, groundSpeedKt: 180, trackDeg: 185, distanceKm: 8.41, bearingDeg: 182.3, offsetDeg: -6 },
  { id: 'a8b3d2', callsign: 'DAL88', registration: 'N826NW', typeCode: 'A333', typeName: 'Airbus A330-300', airline: 'Delta Air Lines', origin: 'ATL', destination: 'CDG', lat: 33.88, lon: -84.3, altitudeFt: 11000, groundSpeedKt: 290, trackDeg: 45, distanceKm: 14.62, bearingDeg: 37.4, offsetDeg: 12 },
  { id: 'ad44b1', callsign: 'N52GT', registration: 'N52GT', typeCode: 'C172', typeName: 'Cessna 172 Skyhawk', airline: null, origin: null, destination: null, lat: 33.8, lon: -84.36, altitudeFt: 2500, groundSpeedKt: 95, trackDeg: 60, distanceKm: 4.31, bearingDeg: 51.0, offsetDeg: 2 },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stateEl = $('state');
const answerEl = $('answer');
const logEl = $('log');
const planeSel = $<HTMLSelectElement>('plane');
const sayInput = $<HTMLInputElement>('say');
const speakChk = $<HTMLInputElement>('speak');
const grokVoiceChk = $<HTMLInputElement>('grokvoice');
const stopBtn = $<HTMLButtonElement>('stop');

planeSel.add(new Option('(none in view)', ''));
for (const p of SAMPLE_PLANES) planeSel.add(new Option(`${p.callsign} · ${p.typeName}`, p.id));
planeSel.value = SAMPLE_PLANES[0].id;

function log(line: string) {
  logEl.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

/** Fake recognizer: the text box feeds transcripts in as final results. */
function createFakeRecognizer(): Recognizer {
  const r: Recognizer = { start: () => log('[fake mic] start'), stop: () => log('[fake mic] stop'), onResult: null, onError: null };
  fakeFeed = (text) => r.onResult?.(text, true);
  return r;
}
let fakeFeed: ((text: string) => void) | null = null;

let voice: VoiceHandle | null = null;

function begin(useRealMic: boolean) {
  voice?.stop();
  fakeFeed = null;
  voice = startVoice({
    getCurrentPlane: () => SAMPLE_PLANES.find((p) => p.id === planeSel.value) ?? null,
    getNearbyPlanes: () => SAMPLE_PLANES,
    onStateChange: (s: VoiceState) => {
      stateEl.textContent = s;
      stateEl.dataset.s = s;
      log(`state -> ${s}`);
    },
    onTranscript: (t) => log(`heard: "${t}"`),
    onAnswer: (a) => {
      answerEl.textContent = a;
      log(`answer: "${a}"`);
    },
    onError: (m) => log(`ERROR: ${m}`),
    speak: speakChk.checked,
    ttsEndpoint: grokVoiceChk.checked ? '/api/voice/speak' : null,
    recognizer: useRealMic ? undefined : createFakeRecognizer(),
  });
  stopBtn.disabled = false;
  log(useRealMic ? 'started with real mic' : 'started with fake mic');
}

$('start-fake').onclick = () => begin(false);
$('start-real').onclick = () => begin(true);
stopBtn.onclick = () => {
  voice?.stop();
  voice = null;
  stopBtn.disabled = true;
  log('stopped');
};

function say() {
  const text = sayInput.value.trim();
  if (!text) return;
  sayInput.value = '';
  if (fakeFeed) {
    log(`[fake mic] "${text}"`);
    fakeFeed(text);
  } else if (voice) {
    log(`(real mic active; asking directly) "${text}"`);
    void voice.ask(text);
  } else {
    log('start first');
  }
}
$('say-btn').onclick = say;
sayInput.onkeydown = (e) => {
  if (e.key === 'Enter') say();
};
$('tilt').onclick = () => {
  voice ? voice.listen() : log('start first');
};
