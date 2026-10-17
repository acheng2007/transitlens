// Desktop test harness for the voice module. Open http://localhost:5173/src/voice/dev.html
// with `npm run dev` running in web/. Not part of the app.

import { startVoice } from './index';
import { createTransitConversation } from './transit';
import { applyMapAction, createMapState } from '../map-state';
import type { Recognizer, VoiceHandle, VoiceState } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stateEl = $('state');
const answerEl = $('answer');
const logEl = $('log');
const busInput = $<HTMLInputElement>('bus');
const scripted = $<HTMLInputElement>('scripted');
let map = createMapState(5);
const conversation = createTransitConversation(() => ({
  focusedBusId: busInput.value.trim() || null,
  position: { lat: 29.6465, lon: -82.3478 }, radiusKm: 5,
  map: { mode: map.mode, extentKm: map.extentKm },
}), actions => {
  actions.forEach(action => { map = applyMapAction(map, action); });
  log(`applied map: ${JSON.stringify(map)}`);
  return `Map ${map.mode}, ${map.extentKm} kilometers.`;
});
const sayInput = $<HTMLInputElement>('say');
const speakChk = $<HTMLInputElement>('speak');
const stopBtn = $<HTMLButtonElement>('stop');

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
  conversation.reset();
  voice = startVoice({
    onCaptureStart: () => conversation.capture(),
    requestAnswer: async (question, signal) => {
      if (!scripted.checked) return conversation.ask(question, signal);
      const q = question.toLowerCase();
      if (/expand|open.*map/.test(q)) map = applyMapAction(map, { type: 'set_map_mode', mode: 'expanded' });
      else if (/close.*map|compact/.test(q)) map = applyMapAction(map, { type: 'set_map_mode', mode: 'compact' });
      else if (/zoom/.test(q)) map = applyMapAction(map, { type: 'set_map_extent', extentKm: map.extentKm * (/out/.test(q) ? 2 : 0.5) });
      else return 'Scripted demo: route 38 reports Gainesville Place. Delay, occupancy and arrival times are unknown. This is synthetic data.';
      log(`scripted map: ${JSON.stringify(map)}`);
      return `Scripted demo: map ${map.mode}, ${map.extentKm} kilometers.`;
    },
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
    ttsEndpoint: null,
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
