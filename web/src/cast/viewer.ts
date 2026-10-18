// Laptop side of casting (/cast.html): offers to receive video, waits for the phone's answer,
// shows the stream full-window, and can record it to a .webm for the demo video.
//
// If the direct peer-to-peer video isn't live within RELAY_AFTER_MS (phone on cellular, or Wi-Fi
// that isolates devices), it switches to the relay: JPEG stills from the phone via the dev server,
// drawn into a canvas whose stream feeds the same <video> (so Record keeps working). Direct video
// takes over again as soon as it connects.

import { ICE_SERVERS, postJson, waitForIceGathering } from './rtc';

const video = document.getElementById('video') as HTMLVideoElement;
const empty = document.getElementById('empty')!;
const bar = document.getElementById('bar')!;
const dot = document.getElementById('dot')!;
const statusEl = document.getElementById('status')!;
const recBtn = document.getElementById('rec-btn') as HTMLButtonElement;
const reconnectBtn = document.getElementById('reconnect-btn') as HTMLButtonElement;
const fsBtn = document.getElementById('fs-btn') as HTMLButtonElement;

const ANSWER_POLL_MS = 1000;
const RECONNECT_MS = 2000;
const RELAY_AFTER_MS = 6000;

let pc: RTCPeerConnection | null = null;
let attempt = 0;
let reconnectTimer = 0;
let remote: MediaStream | null = null;

// ---- Relay fallback ------------------------------------------------------------

let relayImg: HTMLImageElement | null = null;
let relayRaf = 0;
let relayTimer = 0;
const relayCanvas = document.createElement('canvas');
relayCanvas.width = 960;
relayCanvas.height = 720;
const relayCtx = relayCanvas.getContext('2d')!;

const directLive = () => pc?.connectionState === 'connected';

function startRelay() {
  if (relayImg || directLive()) return;
  const img = new Image();
  relayImg = img;
  img.src = `/api/cast/stream?t=${Date.now()}`;
  setStatus('relay · waiting for the phone…');
  let shown = false;
  const draw = () => {
    if (relayImg !== img) return;
    if (img.naturalWidth) {
      if (relayCanvas.width !== img.naturalWidth) {
        relayCanvas.width = img.naturalWidth;
        relayCanvas.height = img.naturalHeight;
      }
      relayCtx.drawImage(img, 0, 0);
      if (!shown) {
        shown = true;
        video.srcObject = relayCanvas.captureStream(24);
        empty.hidden = true;
        setStatus('live · relay (no direct connection)', true);
      }
    }
    relayRaf = requestAnimationFrame(draw);
  };
  relayRaf = requestAnimationFrame(draw);
}

function stopRelay() {
  if (!relayImg) return;
  relayImg.src = '';
  relayImg = null;
  cancelAnimationFrame(relayRaf);
}

function scheduleRelay() {
  clearTimeout(relayTimer);
  relayTimer = window.setTimeout(() => { if (!directLive()) startRelay(); }, RELAY_AFTER_MS);
}

function setStatus(text: string, live = false) {
  statusEl.textContent = text;
  dot.classList.toggle('live', live);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const myAttempt = ++attempt;
  clearTimeout(reconnectTimer);
  pc?.close();
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc = conn;
  conn.addTransceiver('video', { direction: 'recvonly' });
  conn.ontrack = (e) => {
    remote = e.streams[0] ?? new MediaStream([e.track]);
    if (!relayImg) {
      video.srcObject = remote;
      empty.hidden = true;
    }
  };
  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    const s = conn.connectionState;
    if (s === 'connected') {
      // Direct video won: drop the relay and show the real stream.
      stopRelay();
      if (remote) video.srcObject = remote;
      empty.hidden = true;
      setStatus('live', true);
    } else if (!relayImg) setStatus(s);
    // Phone restarted or dropped: make a fresh offer it can pick up.
    if (s === 'failed' || s === 'disconnected' || s === 'closed') {
      reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
    }
  };

  try {
    setStatus('preparing…');
    await conn.setLocalDescription(await conn.createOffer());
    await waitForIceGathering(conn);
    const { id } = await postJson<{ id: number }>('/api/cast/offer', { sdp: conn.localDescription!.sdp });
    setStatus('waiting for the headset…');
    while (attempt === myAttempt) {
      const res = await fetch(`/api/cast/answer?id=${id}`);
      if (res.status === 200) {
        const { sdp } = await res.json();
        await conn.setRemoteDescription({ type: 'answer', sdp });
        setStatus('connecting…');
        return;
      }
      await sleep(ANSWER_POLL_MS);
    }
  } catch (e) {
    setStatus(`error: ${(e as Error).message}`);
    reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
  }
}

// ---- Recording ---------------------------------------------------------------

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

function pickMimeType(): string {
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

function toggleRecording() {
  if (recorder) {
    recorder.stop();
    return;
  }
  const stream = video.srcObject as MediaStream | null;
  if (!stream) {
    setStatus('nothing to record yet');
    return;
  }
  chunks = [];
  const mimeType = pickMimeType();
  recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: 6_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `transitlens-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    recorder = null;
    recBtn.classList.remove('recording');
    recBtn.textContent = '● Record';
  };
  recorder.start(1000);
  recBtn.classList.add('recording');
  recBtn.textContent = '■ Stop & save';
}

// ---- UI ------------------------------------------------------------------------

recBtn.addEventListener('click', toggleRecording);
reconnectBtn.addEventListener('click', () => { stopRelay(); connect(); scheduleRelay(); });
fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});
// H hides the control bar (e.g. for projecting); it also fades after 3 s without mouse movement.
let hideTimer = 0;
function showBar() {
  bar.classList.remove('hidden');
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (!recorder && video.srcObject) bar.classList.add('hidden');
  }, 3000);
}
document.addEventListener('mousemove', showBar);
document.addEventListener('keydown', (e) => {
  if (e.key === 'h') bar.classList.toggle('hidden');
  if (e.key === 'r') toggleRecording();
});

showBar();
connect();
scheduleRelay();
