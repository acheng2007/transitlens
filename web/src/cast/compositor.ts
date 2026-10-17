// Builds the cast frame on the phone: one (mono) view of the camera with the HUD drawn on top,
// captured as a MediaStream for WebRTC. Viewers get what the wearer sees, without the stereo split.

/** 4:3 like the camera stream, so the full camera field of view is kept. */
const OUT_W = 960;
const OUT_H = 720;
/** The HUD is drawn at an eye-like logical width and scaled up, so text sizes match the headset. */
const LOGICAL_W = 480;
const FPS = 24;

export type CastCompositor = {
  stream: MediaStream;
  /** Width / height of the cast frame (for computing its visible FOV). */
  aspect: number;
  /**
   * Draws one frame (throttled to FPS). `drawOverlay` gets a context in logical units
   * (LOGICAL_W wide) and should draw the HUD exactly as for one eye.
   */
  draw: (
    source: HTMLVideoElement | HTMLCanvasElement | null,
    timeMs: number,
    drawOverlay: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  ) => void;
  stop: () => void;
};

/** Same crop as `object-fit: cover`. */
function drawCover(ctx: CanvasRenderingContext2D, video: HTMLVideoElement | HTMLCanvasElement, w: number, h: number) {
  const vw = video instanceof HTMLVideoElement ? video.videoWidth : video.width;
  const vh = video instanceof HTMLVideoElement ? video.videoHeight : video.height;
  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
}

export function createCastCompositor(): CastCompositor {
  const out = document.createElement('canvas');
  out.width = OUT_W;
  out.height = OUT_H;
  const ctx = out.getContext('2d')!;

  // The HUD clears its own canvas every frame, so it gets a separate layer composited on top.
  const hud = document.createElement('canvas');
  hud.width = OUT_W;
  hud.height = OUT_H;
  const hctx = hud.getContext('2d')!;
  const scale = OUT_W / LOGICAL_W;
  hctx.setTransform(scale, 0, 0, scale, 0, 0);

  const stream = out.captureStream(FPS);
  // HUD text must stay sharp: tell the encoder this is detailed content, not motion video.
  for (const track of stream.getVideoTracks()) track.contentHint = 'detail';
  let lastDraw = -Infinity;

  return {
    stream,
    aspect: OUT_W / OUT_H,
    draw(source, timeMs, drawOverlay) {
      if (timeMs - lastDraw < 1000 / FPS - 2) return;
      lastDraw = timeMs;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      const ready = source instanceof HTMLVideoElement ? source.videoWidth > 0 : !!source?.width;
      if (source && ready) drawCover(ctx, source, OUT_W, OUT_H);
      drawOverlay(hctx, LOGICAL_W, OUT_H / scale);
      ctx.drawImage(hud, 0, 0);
    },
    stop() {
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
