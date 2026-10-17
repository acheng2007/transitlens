// Side-by-side stereo view: the same camera feed shown once per eye, with each
// eye centered under its Cardboard lens rather than naively at 1/4 and 3/4 of the screen.

export type Eye = {
  root: HTMLDivElement;
  video: HTMLVideoElement;
  /** Per-frame HUD (plane labels, compass). Drawn in CSS px; DPR scaling is handled in layout. */
  ctx: CanvasRenderingContext2D;
  /** DOM overlay for occasional UI (crosshair, toasts, errors). */
  overlay: HTMLDivElement;
};

export type StereoLayout = {
  pxPerMm: number;
  /** Distance between the two lens centers. */
  ipdMm: number;
  /** Horizontal shift of both eyes (+ = right), for a phone that isn't centered in the headset. */
  offsetMm: number;
  /** Fraction of the available eye area the image fills. */
  viewScale: number;
  /** Rotation of the whole stereo layout (+ = clockwise), for a phone sitting crooked in the headset. */
  tiltDeg: number;
};

export type StereoView = {
  eyes: [Eye, Eye];
  /** Call whenever the viewport or settings change. */
  layout: (l: StereoLayout) => void;
  /** Size of one eye viewport in CSS px (after the latest layout). */
  eyeSize: () => { width: number; height: number };
};

function makeEye(stream: MediaStream | null): Eye {
  const root = document.createElement('div');
  root.className = 'eye';

  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  if (stream) video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.className = 'eye-hud';

  const overlay = document.createElement('div');
  overlay.className = 'eye-overlay';

  root.append(video, canvas, overlay);
  return { root, video, ctx: canvas.getContext('2d')!, overlay };
}

/** `stream` may be null (desktop dev mode without a camera). */
export function createStereoView(container: HTMLElement, stream: MediaStream | null): StereoView {
  const eyes: [Eye, Eye] = [makeEye(stream), makeEye(stream)];
  container.replaceChildren(eyes[0].root, eyes[1].root);

  let size = { width: 0, height: 0 };

  function layout({ pxPerMm, ipdMm, offsetMm, viewScale, tiltDeg }: StereoLayout) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const ipdPx = ipdMm * pxPerMm;
    // Lens centers lie on a line through the screen middle, rotated by the phone's tilt.
    // Rotating this line (not just each image) is what puts one eye higher than the other.
    const t = (tiltDeg * Math.PI) / 180;
    const cx = W / 2 + offsetMm * pxPerMm;
    const cy = H / 2;
    const dx = (Math.cos(t) * ipdPx) / 2;
    const dy = (Math.sin(t) * ipdPx) / 2;
    const centers = [
      [cx - dx, cy - dy],
      [cx + dx, cy + dy],
    ];
    // Eyes touch in the middle when there's room; never wider than the lens spacing.
    const eyeW = Math.max(0, Math.min(ipdPx, W - ipdPx)) * viewScale;
    const eyeH = H * viewScale;
    eyes.forEach((eye, i) => {
      const [x, y] = centers[i];
      Object.assign(eye.root.style, {
        left: `${x - eyeW / 2}px`,
        top: `${y - eyeH / 2}px`,
        width: `${eyeW}px`,
        height: `${eyeH}px`,
        transform: tiltDeg ? `rotate(${tiltDeg}deg)` : '',
      });
      const dpr = window.devicePixelRatio || 1;
      eye.ctx.canvas.width = Math.round(eyeW * dpr);
      eye.ctx.canvas.height = Math.round(eyeH * dpr);
      eye.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    size = { width: eyeW, height: eyeH };
  }

  return { eyes, layout, eyeSize: () => size };
}
